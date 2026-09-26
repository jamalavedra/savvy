import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import ManagedAccount from "./ManagedAccount";
import { managedBilling } from "./lib/api";
import catalog from "../config/managed-catalog.json";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const account = {
  nowMs: 1,
  meetingMsAvailable: 0,
  meetingMsReserved: 0,
  briefsAvailable: 0,
  monthlyMsTotal: 0,
  monthlyMsUsed: 0,
  periodEndMs: null,
  subscription: null,
  catalog,
  paymentPending: true,
  pendingPurchases: [
    { product: "pack", attemptId: "durable-attempt", status: "pending" },
  ],
};
afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  vi.resetAllMocks();
});

describe("desktop billing command boundary", () => {
  it("keeps sign-out confirmation open through pending billing and failed sign-out", async () => {
    window.__TAURI_INTERNALS__ = {};
    let finishBilling!: () => void;
    let failSignOut = true;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "managed_account") return account;
      if (command === "managed_billing")
        await new Promise<void>((resolve) => {
          finishBilling = resolve;
        });
      if (command === "managed_sign_out" && failSignOut)
        throw new Error("sign-out failed");
    });
    render(<ManagedAccount />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    const dialog = screen.getByRole("dialog", { name: "Sign out of Savvy?" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Manage billing" }),
    );
    await waitFor(() => expect(finishBilling).toBeDefined());
    const confirm = within(dialog).getByRole("button", {
      name: "Sign out",
    });
    expect(confirm).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    fireEvent.click(confirm);
    expect(dialog).toBeInTheDocument();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "managed_sign_out"),
    ).toHaveLength(0);
    await act(async () => finishBilling());
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "sign-out failed",
    );
    expect(dialog).toBeInTheDocument();
    failSignOut = false;
    fireEvent.click(confirm);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "managed_sign_out"),
    ).toHaveLength(2);
  });
  it("reuses the server attempt after an ambiguous command failure", async () => {
    window.__TAURI_INTERNALS__ = {};
    let fail = true;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "managed_account") return account;
      if (fail) {
        fail = false;
        throw new Error("provider_unavailable: unknown outcome");
      }
    });
    await expect(managedBilling("pack")).rejects.toThrow("unknown outcome");
    await managedBilling("pack");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "managed_billing"),
    ).toEqual([
      [
        "managed_billing",
        { product: "pack", idempotencyKey: "durable-attempt" },
      ],
      [
        "managed_billing",
        { product: "pack", idempotencyKey: "durable-attempt" },
      ],
    ]);
  });
  it.each([true, false])(
    "blocks duplicate submissions in compact=%s",
    async (compact) => {
      window.__TAURI_INTERNALS__ = {};
      let finish!: () => void;
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === "managed_account") return account;
        if (command === "managed_billing")
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
      });
      render(<ManagedAccount compact={compact} />);
      const button = await screen.findByRole("button", {
        name: "Retry pending hours pack",
      });
      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => expect(finish).toBeDefined());
      expect(button).toBeDisabled();
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([name]) => name === "managed_billing"),
      ).toHaveLength(1);
      await act(async () => finish());
      expect(button).toBeEnabled();
    },
  );
  it("keeps an unresolved purchase pending despite an old confirmed failure", async () => {
    window.__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockResolvedValue({
      ...account,
      paymentPending: false,
      latestConfirmedPurchase: {
        product: "pack",
        attemptId: "old",
        status: "failed",
      },
    });
    render(<ManagedAccount />);
    await screen.findByText(/Payment pending/);
    expect(
      screen.getByRole("region", { name: "Payment pending" }),
    ).toHaveTextContent("You can keep using any remaining allowance");
    expect(
      screen.getByRole("heading", { name: "Hours pack payment" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Refresh account" }),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Monthly plan" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Your last payment was not completed/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try checkout again" }),
    ).not.toBeInTheDocument();
  });
  it.each([false, true])(
    "recovers only known purchase identities when multiple pending=%s",
    async (multiple) => {
      window.__TAURI_INTERNALS__ = {};
      const purchases = multiple
        ? [
            {
              product: "monthly",
              attemptId: "monthly-attempt",
              status: "pending",
            },
            { product: "pack", attemptId: "pack-attempt", status: "pending" },
          ]
        : [];
      vi.mocked(invoke).mockImplementation(async (command) =>
        command === "managed_account"
          ? { ...account, pendingPurchases: purchases }
          : undefined,
      );
      render(<ManagedAccount />);
      const card = await screen.findByRole("region", {
        name: "Payment pending",
      });
      expect(
        within(card).getByRole("heading", { name: "Payment confirmation" }),
      ).toBeInTheDocument();
      expect(within(card).getAllByRole("button")).toHaveLength(
        multiple ? 3 : 1,
      );
      for (const purchase of purchases) {
        const button = within(card).getByRole("button", {
          name:
            purchase.product === "monthly"
              ? "Retry pending monthly plan"
              : "Retry pending hours pack",
        });
        fireEvent.click(button);
        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("managed_billing", {
            product: purchase.product,
            idempotencyKey: purchase.attemptId,
          }),
        );
        await waitFor(() => expect(button).toBeEnabled());
      }
      const readsBefore = vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "managed_account").length;
      fireEvent.click(
        within(card).getByRole("button", { name: "Refresh account" }),
      );
      await waitFor(() =>
        expect(
          vi
            .mocked(invoke)
            .mock.calls.filter(([name]) => name === "managed_account").length,
        ).toBeGreaterThan(readsBefore),
      );
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([name]) => name === "managed_billing"),
      ).toHaveLength(purchases.length);
      expect(card).toBeInTheDocument();
    },
  );
  it.each(["failed", "expired"])(
    "offers explicit retry only after confirmed %s",
    async (status) => {
      window.__TAURI_INTERNALS__ = {};
      vi.mocked(invoke).mockImplementation(async (command) =>
        command === "managed_account"
          ? {
              ...account,
              paymentPending: false,
              pendingPurchases: [],
              latestConfirmedPurchase: {
                product: "pack",
                attemptId: "closed",
                status,
              },
            }
          : undefined,
      );
      render(<ManagedAccount />);
      const retry = await screen.findByRole("button", {
        name: "Try checkout again",
      });
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([name]) => name === "managed_billing"),
      ).toHaveLength(0);
      fireEvent.click(retry);
      await waitFor(() =>
        expect(
          vi
            .mocked(invoke)
            .mock.calls.filter(([name]) => name === "managed_billing"),
        ).toHaveLength(1),
      );
      const call = vi
        .mocked(invoke)
        .mock.calls.find(([name]) => name === "managed_billing");
      expect(call?.[1]).toMatchObject({ product: "pack" });
      expect((call?.[1] as { idempotencyKey: string }).idempotencyKey).not.toBe(
        "closed",
      );
      const back = screen.getByRole("button", { name: "Back to account" });
      await waitFor(() => expect(back).toBeEnabled());
      fireEvent.click(back);
      expect(
        screen.queryByRole("region", { name: "Payment not completed" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Your account" }),
      ).toHaveFocus();
    },
  );
  it("reopens a pending monthly purchase when Stripe reports an incomplete subscription", async () => {
    window.__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockResolvedValue({
      ...account,
      subscription: {
        status: "incomplete",
        paidThroughMs: null,
        cancelAtPeriodEnd: false,
      },
      pendingPurchases: [
        {
          product: "monthly",
          attemptId: "monthly-pending",
          status: "payment_pending",
        },
      ],
    });
    render(<ManagedAccount />);
    expect(
      await screen.findByRole("button", { name: "Retry pending monthly plan" }),
    ).toBeEnabled();
  });
});
