import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import Onboarding from "./Onboarding";
import { resetBrowserDemoState } from "./lib/api";

const checkMicrophonePermission = vi.fn<() => Promise<boolean>>();
const checkScreenRecordingPermission = vi.fn<() => Promise<boolean>>();
const requestMicrophonePermission = vi.fn<() => Promise<void>>();
const requestScreenRecordingPermission = vi.fn<() => Promise<void>>();

vi.mock("tauri-plugin-macos-permissions-api", () => ({
  checkMicrophonePermission: () => checkMicrophonePermission(),
  checkScreenRecordingPermission: () => checkScreenRecordingPermission(),
  requestMicrophonePermission: () => requestMicrophonePermission(),
  requestScreenRecordingPermission: () => requestScreenRecordingPermission(),
}));

const getAppStatus =
  vi.fn<() => Promise<{ version: string; platform: string }>>();
const getTranscriptionKeyStatus =
  vi.fn<() => Promise<{ deepgram: boolean; assemblyAi: boolean }>>();
const setTranscriptionApiKey =
  vi.fn<
    (
      provider: string,
      key: string,
    ) => Promise<{ deepgram: boolean; assemblyAi: boolean }>
  >();

vi.mock("./lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/api")>()),
  getAppStatus: () => getAppStatus(),
  getTranscriptionKeyStatus: () => getTranscriptionKeyStatus(),
  setTranscriptionApiKey: (provider: string, key: string) =>
    setTranscriptionApiKey(provider, key),
}));

/** Leaves the user in System Settings long enough for any bounded wait to lapse. */
async function exhaustPermissionPolling() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
}

/** The visible guidance copy under the permission rows. */
function guidanceText() {
  return Array.from(document.querySelectorAll(".onboarding-note"))
    .map((note) => note.textContent ?? "")
    .join(" ");
}

/** The visible error copy, whatever element carries it. */
function errorText() {
  return document.querySelector(".onboarding-error")?.textContent ?? null;
}

async function findErrorText() {
  await waitFor(() => expect(errorText()).not.toBeNull());
  return errorText() ?? "";
}

function row(title: string) {
  const heading = screen.getByText(title);
  const element = heading.closest(".onboarding-row");
  if (!element) throw new Error(`no permission row for ${title}`);
  return element as HTMLElement;
}

function rowButton(title: string) {
  const control = row(title).querySelector("button");
  if (!control) throw new Error(`row ${title} has no action`);
  return control;
}

function renderOnboarding(returningUser = false) {
  const onComplete = vi.fn();
  render(<Onboarding returningUser={returningUser} onComplete={onComplete} />);
  return onComplete;
}

describe("Onboarding on macOS", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getAppStatus.mockResolvedValue({ version: "0.1.0", platform: "macos" });
    getTranscriptionKeyStatus.mockResolvedValue({
      deepgram: false,
      assemblyAi: false,
    });
    setTranscriptionApiKey.mockResolvedValue({
      deepgram: true,
      assemblyAi: false,
    });
    checkMicrophonePermission.mockResolvedValue(false);
    checkScreenRecordingPermission.mockResolvedValue(false);
    requestMicrophonePermission.mockResolvedValue(undefined);
    requestScreenRecordingPermission.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("blocks Continue until the microphone is allowed and says why", async () => {
    renderOnboarding();

    await waitFor(() => expect(rowButton("Microphone")).toBeEnabled());
    const advance = screen.getByRole("button", { name: "Continue" });
    expect(advance).toBeDisabled();
    // A disabled control with no explanation strands the user. The screen has to
    // say which permission is still missing.
    expect(
      screen.getByText(/[Mm]icrophone .*(required|needed|before)/),
    ).toBeVisible();
  });

  it("flips the row to Allowed as soon as macOS reports the grant", async () => {
    renderOnboarding();
    await waitFor(() => expect(rowButton("Microphone")).toBeEnabled());

    checkMicrophonePermission.mockResolvedValue(true);
    fireEvent.click(rowButton("Microphone"));

    await waitFor(() => expect(row("Microphone")).toHaveTextContent("Allowed"));
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("guides the user to System Settings when the microphone stays denied", async () => {
    renderOnboarding();
    await waitFor(() => expect(rowButton("Microphone")).toBeEnabled());

    fireEvent.click(rowButton("Microphone"));
    expect(row("Microphone")).toHaveTextContent("Waiting…");

    await exhaustPermissionPolling();

    // The user is still in System Settings. The row must keep waiting and keep
    // saying where to go, not revert to "Allow" as if nothing had happened.
    expect(row("Microphone")).toHaveTextContent("Waiting…");
    expect(guidanceText()).toMatch(/System Settings/);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("recovers on its own when the grant lands after the poll window", async () => {
    renderOnboarding();
    await waitFor(() => expect(rowButton("Microphone")).toBeEnabled());

    fireEvent.click(rowButton("Microphone"));
    await exhaustPermissionPolling();

    // The user is in System Settings. Setup must notice the grant without them
    // hunting for a "Check again" button they cannot see from that window.
    checkMicrophonePermission.mockResolvedValue(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    await waitFor(() => expect(row("Microphone")).toHaveTextContent("Allowed"));
  });

  it("re-reads permissions when the window regains focus", async () => {
    renderOnboarding();
    await waitFor(() => expect(rowButton("Microphone")).toBeEnabled());

    checkMicrophonePermission.mockResolvedValue(true);
    checkScreenRecordingPermission.mockResolvedValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(100);
    });

    await waitFor(() => expect(row("Microphone")).toHaveTextContent("Allowed"));
    expect(row("Screen & system audio")).toHaveTextContent("Allowed");
  });

  it("reports a failed permission request instead of silently doing nothing", async () => {
    requestMicrophonePermission.mockRejectedValue(new Error("plugin missing"));
    renderOnboarding();
    await waitFor(() => expect(rowButton("Microphone")).toBeEnabled());

    fireEvent.click(rowButton("Microphone"));

    expect(await findErrorText()).toMatch(
      /could not request microphone access/i,
    );
    expect(rowButton("Microphone")).toHaveTextContent("Allow");
  });

  it("tells the user when the permission check itself fails", async () => {
    getAppStatus.mockRejectedValue(new Error("ipc unavailable"));
    renderOnboarding();

    expect(await findErrorText()).toMatch(/check/i);
  });

  it("explains the screen recording restart requirement and keeps it optional", async () => {
    checkMicrophonePermission.mockResolvedValue(true);
    renderOnboarding();
    await waitFor(() =>
      expect(rowButton("Screen & system audio")).toBeEnabled(),
    );

    fireEvent.click(rowButton("Screen & system audio"));
    await exhaustPermissionPolling();

    expect(guidanceText()).toMatch(/reopen Savvy/);
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(screen.getByText(/Savvy only hears you/)).toBeVisible();
  });

  it("lets the user dismiss an onboarding error", async () => {
    requestMicrophonePermission.mockRejectedValue(new Error("plugin missing"));
    renderOnboarding();
    await waitFor(() => expect(rowButton("Microphone")).toBeEnabled());

    fireEvent.click(rowButton("Microphone"));
    await findErrorText();

    fireEvent.click(screen.getByRole("button", { name: /Dismiss/i }));
    expect(errorText()).toBeNull();
  });

  it("clears a stale error when the user moves to the next step", async () => {
    requestMicrophonePermission.mockRejectedValue(new Error("plugin missing"));
    renderOnboarding();
    await waitFor(() => expect(rowButton("Microphone")).toBeEnabled());

    fireEvent.click(rowButton("Microphone"));
    await findErrorText();

    checkMicrophonePermission.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText(/Deepgram API key/)).toBeVisible();
    // The permission error belongs to the step the user just left.
    expect(errorText()).toBeNull();
  });

  it("surfaces and then clears a key-storage failure", async () => {
    checkMicrophonePermission.mockResolvedValue(true);
    renderOnboarding();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const field = await screen.findByPlaceholderText("Paste your API key");
    setTranscriptionApiKey.mockRejectedValueOnce(new Error("Keychain locked"));
    fireEvent.change(field, { target: { value: "test-api-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    expect(await findErrorText()).toContain("Keychain locked");

    setTranscriptionApiKey.mockResolvedValue({
      deepgram: true,
      assemblyAi: false,
    });
    fireEvent.change(field, { target: { value: "test-api-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(screen.getByText("Key saved")).toBeVisible());
    expect(errorText()).toBeNull();
  });

  it("finishes without a key but says what will not work", async () => {
    checkMicrophonePermission.mockResolvedValue(true);
    const onComplete = renderOnboarding();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByText(/meetings cannot be transcribed/),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onComplete).toHaveBeenCalled();
  });

  it("announces onboarding errors to assistive technology", async () => {
    requestMicrophonePermission.mockRejectedValue(new Error("plugin missing"));
    renderOnboarding();
    await waitFor(() => expect(rowButton("Microphone")).toBeEnabled());

    fireEvent.click(rowButton("Microphone"));
    await findErrorText();

    expect(screen.getByRole("alert")).toHaveTextContent(
      /could not request microphone access/i,
    );
  });

  it("does not carry a screen recording error into the key step", async () => {
    checkMicrophonePermission.mockResolvedValue(true);
    requestScreenRecordingPermission.mockRejectedValue(new Error("no plugin"));
    renderOnboarding();
    await waitFor(() =>
      expect(rowButton("Screen & system audio")).toBeEnabled(),
    );

    fireEvent.click(rowButton("Screen & system audio"));
    expect(await findErrorText()).toMatch(/screen recording access/i);

    // Screen recording is optional, so Continue is the expected way forward.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/Deepgram API key/)).toBeVisible();
    expect(errorText()).toBeNull();
  });

  it("sends a returning user straight back to work once repaired", async () => {
    checkMicrophonePermission.mockResolvedValue(true);
    checkScreenRecordingPermission.mockResolvedValue(true);
    const onComplete = renderOnboarding(true);

    expect(await screen.findByText(/needs its permissions back/)).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onComplete).toHaveBeenCalled();
    expect(getTranscriptionKeyStatus).not.toHaveBeenCalled();
  });
});

describe("Onboarding gate on relaunch", () => {
  beforeEach(() => {
    resetBrowserDemoState();
    getAppStatus.mockResolvedValue({ version: "0.1.0", platform: "macos" });
    getTranscriptionKeyStatus.mockResolvedValue({
      deepgram: true,
      assemblyAi: false,
    });
    requestMicrophonePermission.mockResolvedValue(undefined);
    requestScreenRecordingPermission.mockResolvedValue(undefined);
  });

  afterEach(() => vi.clearAllMocks());

  it("fronts setup when the microphone was revoked", async () => {
    checkMicrophonePermission.mockResolvedValue(false);
    checkScreenRecordingPermission.mockResolvedValue(true);
    render(<App />);

    expect(
      await screen.findByRole("dialog", { name: "Set up Savvy" }),
    ).toBeVisible();
    expect(screen.getByText(/needs its permissions back/)).toBeVisible();
  });

  it("does not wall off the app over the optional screen recording permission", async () => {
    checkMicrophonePermission.mockResolvedValue(true);
    checkScreenRecordingPermission.mockResolvedValue(false);
    render(<App />);

    // Onboarding itself treats system audio as optional, so an install that
    // declined it must not hit a setup screen on every launch.
    expect(
      await screen.findByRole("heading", { name: "Prepare for your meeting" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "Set up Savvy" }),
    ).not.toBeInTheDocument();
  }, 15_000);
});

describe("Onboarding off macOS", () => {
  beforeEach(() => {
    getAppStatus.mockResolvedValue({ version: "0.1.0", platform: "browser" });
    getTranscriptionKeyStatus.mockResolvedValue({
      deepgram: false,
      assemblyAi: false,
    });
  });

  afterEach(() => vi.clearAllMocks());

  it("treats permissions as satisfied and never offers a dead control", async () => {
    renderOnboarding();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    expect(row("Microphone")).toHaveTextContent("Allowed");
    expect(row("Screen & system audio")).toHaveTextContent("Allowed");
    expect(checkMicrophonePermission).not.toHaveBeenCalled();
  });
});
