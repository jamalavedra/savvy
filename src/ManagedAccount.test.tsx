import * as api from "./lib/api";
import userEvent from "@testing-library/user-event";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ManagedAccount from "./ManagedAccount";
import Onboarding from "./Onboarding";
import {
  getAppSettings,
  updateAppSettings,
  resetBrowserDemoState,
  setManagedDemoScenario,
  managedAccount,
  managedBilling,
  managedSignInBegin,
  managedSignInFinish,
  managedSignInCancel,
  managedSignOut,
  generateBriefDraft,
  startMeeting,
  pauseMeeting,
  resumeMeeting,
  stopMeeting,
  requestRecommendation,
} from "./lib/api";

describe("managed account fixtures", () => {
  beforeEach(() => resetBrowserDemoState());
  afterEach(() => vi.useRealTimers());
  it("requires confirmation while the initial account lookup is unresolved", async () => {
    const account = await managedSignInFinish(await managedSignInBegin());
    let finishRead!: (value: typeof account) => void;
    const read = vi.spyOn(api, "managedAccount").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const signOut = vi.spyOn(api, "managedSignOut");
    const user = userEvent.setup();
    try {
      render(<ManagedAccount />);
      await waitFor(() => expect(read).toHaveBeenCalled());
      expect(screen.getByRole("status")).toHaveTextContent(
        "Loading your account",
      );
      expect(
        screen.queryByRole("button", { name: "Sign in to Savvy" }),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /^Sign out/ }));
      const dialog = screen.queryByRole("dialog", {
        name: "Sign out of Savvy?",
      });
      expect(dialog).toBeInTheDocument();
      expect(signOut).not.toHaveBeenCalled();
      await user.click(within(dialog!).getByRole("button", { name: "Cancel" }));
      expect(signOut).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        finishRead(account);
      });
      read.mockRestore();
      signOut.mockRestore();
    }
  });

  it("keeps confirmed sign-out available after an offline account lookup", async () => {
    setManagedDemoScenario("offline");
    const signOut = vi.spyOn(api, "managedSignOut");
    const user = userEvent.setup();
    try {
      render(<ManagedAccount />);
      expect(await screen.findByRole("alert")).not.toHaveTextContent(
        "Last known balance is shown",
      );
      await user.click(screen.getByRole("button", { name: /^Sign out/ }));
      const dialog = screen.queryByRole("dialog", {
        name: "Sign out of Savvy?",
      });
      expect(dialog).toBeInTheDocument();
      expect(signOut).not.toHaveBeenCalled();
      await user.click(
        within(dialog!).getByRole("button", { name: "Sign out" }),
      );
      await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    } finally {
      signOut.mockRestore();
    }
  });

  it("lets an account without allowance view prices before starting checkout", async () => {
    const read = vi.spyOn(api, "managedAccount").mockResolvedValue({
      nowMs: 1,
      meetingMsAvailable: 0,
      meetingMsReserved: 0,
      briefsAvailable: 0,
      monthlyMsTotal: 0,
      monthlyMsUsed: 0,
      periodEndMs: null,
      subscription: null,
      latestConfirmedPurchase: null,
      identity: {
        issuer: "fixture",
        subject: "new",
        name: null,
        email: "alex@example.com",
        emailVerified: true,
      },
    });
    const billing = vi.spyOn(api, "managedBilling");
    try {
      const user = userEvent.setup();
      render(<ManagedAccount />);
      await user.click(
        await screen.findByRole("button", { name: "View plans and pricing" }),
      );
      expect(
        screen.getByRole("region", { name: "Plans and pricing" }),
      ).toBeInTheDocument();
      expect(billing).not.toHaveBeenCalled();
      expect(screen.queryByText(/Assistance paused/)).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Back to account" }));
      expect(
        screen.queryByRole("region", { name: "Plans and pricing" }),
      ).not.toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "View plans and pricing" }),
        ).toHaveFocus(),
      );
    } finally {
      read.mockRestore();
      billing.mockRestore();
    }
  });

  it("shows server-provided monthly and pack balances without replacing historical allowances", async () => {
    const read = vi.spyOn(api, "managedAccount").mockResolvedValue({
      nowMs: 1,
      meetingMsAvailable: 40980000,
      meetingMsReserved: 60000,
      briefsAvailable: 23,
      monthlyMsTotal: 36000000,
      monthlyMsUsed: 5760000,
      periodEndMs: null,
      subscription: {
        status: "active",
        paidThroughMs: null,
        cancelAtPeriodEnd: false,
      },
      allowances: {
        monthly: {
          meetingMsAvailable: 30180000,
          meetingMsReserved: 60000,
          briefsAvailable: 17,
        },
        pack: {
          meetingMsAvailable: 10800000,
          meetingMsReserved: 0,
          briefsAvailable: 6,
        },
      },
    });
    try {
      render(<ManagedAccount />);
      const monthly = await screen.findByRole("region", {
        name: "Monthly remaining",
      });
      expect(monthly).toHaveTextContent("8 h 24 min");
      expect(monthly).toHaveTextContent("17 briefs");
      const packs = screen.getByRole("region", { name: "Purchased packs" });
      expect(packs).toHaveTextContent("3 h 0 min");
      expect(packs).toHaveTextContent("6 briefs");
      expect(packs).toHaveTextContent("No scheduled expiry");
    } finally {
      read.mockRestore();
    }
  });

  it("opens plan and usage without buying and restores the account action focus", async () => {
    setManagedDemoScenario("active");
    const billing = vi.spyOn(api, "managedBilling");
    try {
      const user = userEvent.setup();
      render(<ManagedAccount />);
      const trigger = await screen.findByRole("button", {
        name: "Plan and usage",
      });
      await user.click(trigger);
      expect(
        screen.getByRole("heading", { name: "Plan and usage", level: 2 }),
      ).toHaveFocus();
      expect(
        screen.getByRole("region", { name: "Hours pack offer" }),
      ).toHaveTextContent("$29 once");
      expect(
        screen.getByRole("button", { name: "Buy hours pack" }),
      ).toBeEnabled();
      expect(billing).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Back to account" }));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Plan and usage" }),
        ).toHaveFocus(),
      );
      expect(
        screen.queryByRole("region", { name: "Hours pack offer" }),
      ).not.toBeInTheDocument();
    } finally {
      billing.mockRestore();
    }
  });

  it("models pending cancellation separately from completed sign-in in the synthetic demo", async () => {
    const pending = await managedSignInBegin();
    await managedSignInCancel();
    await expect(managedSignInFinish(pending)).rejects.toThrow("cancelled");
    expect(await managedAccount()).toBeNull();
    const completed = await managedSignInFinish(await managedSignInBegin());
    await expect(managedSignInCancel()).rejects.toThrow("already completed");
    expect(await managedAccount()).toEqual(completed);
    await managedSignOut();
    expect(await managedAccount()).toBeNull();
  });

  it("preserves the selected pack through pricing sign-in", async () => {
    const user = userEvent.setup();
    render(<ManagedAccount pricingOnly />);
    await user.click(screen.getByRole("radio", { name: /Hours pack/ }));
    await user.click(
      screen.getByRole("button", { name: "Continue to checkout" }),
    );
    await screen.findByRole("button", { name: "Continue to checkout" });
    expect((await getAppSettings()).serviceMode).toBe("managed");
    expect((await managedAccount())?.meetingMsAvailable).toBe(10_800_000);
  });
  it("keeps account creation separate from purchase using keyboard controls", async () => {
    const user = userEvent.setup();
    render(<ManagedAccount />);
    const signIn = await screen.findByRole("button", {
      name: "Sign in to Savvy",
    });
    expect(signIn).toBeEnabled();
    await user.tab();
    expect(signIn).toHaveFocus();
    await user.keyboard("{Enter}");
    const viewPlans = await screen.findByRole("button", {
      name: "View plans and pricing",
    });
    viewPlans.focus();
    await user.keyboard("{Enter}");
    const pack = screen.getByRole("radio", { name: /Hours pack/ });
    await user.tab();
    expect(screen.getByRole("radio", { name: /Monthly plan/ })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(pack).toBeChecked();
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Continue to checkout" }),
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByText(/180 meeting minutes and 6 briefs remain/);
  });
  it.each([
    "low",
    "exhausted",
    "paymentPending",
    "pastDue",
    "cancelledWithPacks",
    "offline",
  ] as const)(
    "renders actionable %s state without relying on color",
    async (scenario) => {
      setManagedDemoScenario(scenario);
      render(<ManagedAccount />);
      if (scenario === "offline")
        expect(await screen.findByRole("alert")).toHaveTextContent("offline");
      else if (scenario === "low")
        expect(await screen.findByText(/Two minutes/)).toHaveAttribute(
          "role",
          "status",
        );
      else if (scenario === "exhausted" || scenario === "paymentPending")
        expect(
          await screen.findByText(/Assistance paused/),
        ).toBeInTheDocument();
      else if (scenario === "pastDue")
        await screen.findByText(/Payment overdue/);
      else {
        await screen.findByText(/Renewal canceled/);
        expect(screen.queryByText(/Renews/)).not.toBeInTheDocument();
      }
      expect(
        screen.getByRole("button", { name: "Refresh account" }),
      ).toBeEnabled();
    },
  );
  it("completes the managed allowance lifecycle locally and requires explicit resume after a pack", async () => {
    vi.useFakeTimers();
    await updateAppSettings({
      ...(await getAppSettings()),
      serviceMode: "managed",
    });
    await managedSignInFinish(await managedSignInBegin());
    await expect(startMeeting(null, null)).rejects.toThrow("quota_exhausted");
    await managedBilling("pack");
    await generateBriefDraft(null, "Synthetic context");
    expect((await managedAccount())?.briefsAvailable).toBe(5);
    const meeting = await startMeeting(null, null);
    await requestRecommendation(meeting.id);
    await vi.advanceTimersByTimeAsync(65_000);
    await pauseMeeting(meeting.id);
    await vi.advanceTimersByTimeAsync(20_000);
    await resumeMeeting(meeting.id);
    await vi.advanceTimersByTimeAsync(10_000);
    await pauseMeeting(meeting.id);
    expect((await managedAccount())?.meetingMsAvailable).toBe(
      10_800_000 - 75_000,
    );
    await resumeMeeting(meeting.id);
    await vi.advanceTimersByTimeAsync(10_800_000);
    expect((await managedAccount())?.meetingMsAvailable).toBe(0);
    await managedBilling("pack");
    await expect(requestRecommendation(meeting.id)).rejects.toThrow(
      "session_conflict",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await managedAccount())?.meetingMsAvailable).toBe(10_800_000);
    await resumeMeeting(meeting.id);
    await vi.advanceTimersByTimeAsync(1000);
    await stopMeeting(meeting.id);
    expect((await managedAccount())?.meetingMsAvailable).toBe(10_799_000);
    await updateAppSettings({
      ...(await getAppSettings()),
      serviceMode: "byok",
    });
  });
  it("refreshes and announces exhaustion during meeting preparation", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setManagedDemoScenario("low");
    await updateAppSettings({
      ...(await getAppSettings()),
      serviceMode: "managed",
    });
    const meeting = await startMeeting(null, null);
    render(<ManagedAccount compact />);
    await screen.findByText(/Two minutes or less/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(95_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Assistance paused");
    await stopMeeting(meeting.id);
  });
  it("offers keyboard-only managed onboarding without a transcription key", async () => {
    const user = userEvent.setup();
    render(<Onboarding onComplete={vi.fn()} />);
    const managed = screen.getByRole("button", { name: "Create account" });
    for (let i = 0; i < 10 && document.activeElement !== managed; i++)
      await user.tab();
    expect(managed).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByRole("button", { name: "Set up later" });
    expect(
      screen.queryByPlaceholderText("Paste your API key"),
    ).not.toBeInTheDocument();
    expect((await getAppSettings()).serviceMode).toBe("managed");
  });
});
