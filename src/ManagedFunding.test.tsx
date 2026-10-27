import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ManagedAccount from "./ManagedAccount";
import * as api from "./lib/api";

beforeEach(async () => {
  api.resetBrowserDemoState();
  await api.updateAppSettings({
    ...(await api.getAppSettings()),
    serviceMode: "managed",
  });
  api.setManagedDemoScenario("organization");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("charges seat briefs and meeting time without consuming personal credit", async () => {
  vi.useFakeTimers();
  const before = (await api.managedAccount())!;
  const funding = await api.managedFundingSnapshot();
  await api.generateBriefDraft(null, "Seat context", undefined, funding);
  const meeting = await api.startMeeting(
    null,
    null,
    undefined,
    [],
    [],
    funding,
  );
  await vi.advanceTimersByTimeAsync(12_000);
  await api.pauseMeeting(meeting.id);
  await vi.advanceTimersByTimeAsync(10_000);
  const after = (await api.managedAccount())!;
  expect(after.meetingMsAvailable).toBe(before.meetingMsAvailable);
  expect(after.briefsAvailable).toBe(before.briefsAvailable);
  expect(after.organizationAllowance!.usedMs).toBe(12_000);
  expect(after.organizationAllowance!.usedBriefs).toBe(1);
  await expect(api.managedSetFunding({ kind: "personal" })).rejects.toThrow(
    "funding_mismatch",
  );
  await api.stopMeeting(meeting.id);
  await api.managedSetFunding({ kind: "personal" });
  await api.generateBriefDraft(null, "Personal context");
  expect((await api.managedAccount())!.briefsAvailable).toBe(
    before.briefsAvailable - 1,
  );
  expect((await api.managedAccount())!.organizationAllowance!.usedBriefs).toBe(
    1,
  );
});

it("does not silently use personal credit after a seat is lost", async () => {
  api.setManagedDemoScenario("revokedOrganization");
  const before = (await api.managedAccount())!;
  expect(before.meetingMsAvailable).toBeGreaterThan(0);
  await expect(api.generateBriefDraft(null, "New context")).rejects.toThrow(
    "no_seat",
  );
  await expect(api.startMeeting(null, null)).rejects.toThrow("no_seat");
  const after = (await api.managedAccount())!;
  expect(after.funding).toEqual({ kind: "organization", organizationId: "7" });
  expect(after.meetingMsAvailable).toBe(before.meetingMsAvailable);
  expect(after.briefsAvailable).toBe(before.briefsAvailable);
  render(<ManagedAccount compact />);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Personal credit will not be used automatically",
  );
  expect(
    screen.queryByRole("button", { name: "Buy hours pack" }),
  ).not.toBeInTheDocument();
});

it("rejects a payer changed during preparation before spending either allowance", async () => {
  const funding = await api.managedFundingSnapshot();
  await api.managedSetFunding({ kind: "personal" });
  const before = (await api.managedAccount())!;
  await expect(
    api.generateBriefDraft(null, "Frozen context", undefined, funding),
  ).rejects.toThrow("funding_mismatch");
  await expect(
    api.startMeeting(null, null, undefined, [], [], funding),
  ).rejects.toThrow("funding_mismatch");
  expect((await api.managedAccount())!.briefsAvailable).toBe(
    before.briefsAvailable,
  );
});

it("confirms a deliberate funding change through the shared keyboard selector", async () => {
  const user = userEvent.setup();
  render(<ManagedAccount />);
  const selector = await screen.findByRole("button", {
    name: "Assistance funding",
  });
  expect(selector).toHaveTextContent("Northstar Sales");
  await user.click(selector);
  await user.keyboard("{Home}{Enter}");
  const dialog = await screen.findByRole("dialog", {
    name: "Change assistance funding?",
  });
  expect((await api.managedAccount())!.funding?.kind).toBe("organization");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect((await api.managedAccount())!.funding?.kind).toBe("organization");
  await user.click(selector);
  await user.click(screen.getByRole("option", { name: "Personal allowance" }));
  await user.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Use this payer",
    }),
  );
  expect(
    await screen.findByText(/briefs remain personally/),
  ).toBeInTheDocument();
  expect(selector).toHaveTextContent("Personal allowance");
});

it("shows an unseated membership and disables the seat choice", async () => {
  api.setManagedDemoScenario("unseated");
  const user = userEvent.setup();
  render(<ManagedAccount />);
  await screen.findByText(/member without a paid seat/);
  await user.click(screen.getByRole("button", { name: "Assistance funding" }));
  expect(
    screen.getByRole("option", { name: "Northstar Sales" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Manage organization" }),
  ).toBeEnabled();
});

it("locks the payer while a meeting is paused as well as recording", async () => {
  const meeting = await api.startMeeting(null, null);
  await api.pauseMeeting(meeting.id);
  render(<ManagedAccount />);
  expect(
    await screen.findByRole("button", { name: "Assistance funding" }),
  ).toBeDisabled();
  await api.stopMeeting(meeting.id);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(
    screen.getByRole("button", { name: "Assistance funding" }),
  ).toBeEnabled();
});

it("requires an explicit choice when a saved preference is invalid", async () => {
  const account = (await api.managedAccount())!;
  vi.spyOn(api, "managedAccount").mockResolvedValue({
    ...account,
    funding: { kind: "unavailable" },
    fundingError: "Choose a payer again.",
  });
  render(<ManagedAccount />);
  expect(
    await screen.findByRole("button", { name: "Assistance funding" }),
  ).toHaveTextContent("Choose a payer");
  expect(screen.getByRole("alert")).toHaveTextContent("Choose a payer again");
});

it("links to a desktop update when the seat requires a later release", async () => {
  const account = (await api.managedAccount())!;
  vi.spyOn(api, "managedAccount").mockResolvedValue({
    ...account,
    organization: { ...account.organization!, minimumDesktopVersion: "99.0.0" },
  });
  render(<ManagedAccount />);
  expect(
    await screen.findByText(/Update Savvy to use your team seat/),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Get the latest desktop release" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/jamalavedra/savvy/releases/latest",
  );
});
