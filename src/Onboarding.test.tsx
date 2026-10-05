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
import * as appApi from "./lib/api";
import {
  getAppSettings,
  resetBrowserDemoState,
  updateAppSettings,
} from "./lib/api";
import type { AppSettings, ProviderHealth } from "./types";

const getRecommendationProviderStatus =
  vi.fn<(personalSetup?: boolean) => Promise<ProviderHealth[]>>();

const checkMicrophonePermission = vi.fn<() => Promise<boolean>>();
const checkScreenRecordingPermission = vi.fn<() => Promise<boolean>>();
const requestMicrophonePermission = vi.fn<() => Promise<void>>();
const requestScreenRecordingPermission = vi.fn<() => Promise<void>>();
const probeSystemAudioPermission = vi.fn<() => Promise<void>>();
const reopenApp = vi.fn<() => Promise<void>>();

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
  getRecommendationProviderStatus: (personalSetup?: boolean) =>
    getRecommendationProviderStatus(personalSetup),
  probeSystemAudioPermission: () => probeSystemAudioPermission(),
  reopenApp: () => reopenApp(),
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

async function renderOnboarding(permissions = true) {
  const onComplete = vi.fn();
  render(<Onboarding onComplete={onComplete} />);
  if (permissions) {
    fireEvent.click(
      screen.getByRole("button", { name: "Use your own providers" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Skip for now" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Set up later" }),
    );
  }
  return onComplete;
}

describe("Onboarding on macOS", () => {
  beforeEach(async () => {
    await updateAppSettings({
      ...(await getAppSettings()),
      transcriptionProvider: "deepgram",
      transcriptionModel: "nova-3",
      transcriptionLanguage: "multi",
      microphoneOnly: false,
    });
    getRecommendationProviderStatus.mockResolvedValue([]);
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
    probeSystemAudioPermission.mockRejectedValue(
      new Error("Screen capture is unavailable"),
    );
    reopenApp.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("locks welcome navigation while loading personal setup and recovers after failure", async () => {
    const settings = await getAppSettings();
    let rejectRead!: (reason: Error) => void;
    const read = new Promise<AppSettings>((_, reject) => {
      rejectRead = reject;
    });
    const transport = vi.fn(async (command: string) => {
      if (command === "get_app_settings") return read;
      if (command === "managed_sign_in_cancel") return;
      throw new Error(`Unexpected command: ${command}`);
    });
    window.__TAURI_INTERNALS__ = { invoke: transport };
    try {
      await renderOnboarding(false);
      fireEvent.click(
        screen.getByRole("button", { name: "Use your own providers" }),
      );
      for (const name of [
        "Use your own providers",
        "View pricing",
        "Create account",
        "Sign in",
      ]) {
        expect(screen.getByRole("button", { name })).toBeDisabled();
      }
      await act(async () => rejectRead(new Error("Settings unavailable")));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Settings unavailable",
      );
      expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
      transport.mockImplementation(async (command: string) => {
        if (command === "get_app_settings") return settings;
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Use your own providers" }),
      );
      await screen.findByLabelText("Deepgram API key");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      await act(async () => rejectRead(new Error("Test cleanup")));
      delete window.__TAURI_INTERNALS__;
    }
  });

  it("configures personal providers before leaving interrupted managed onboarding", async () => {
    let settings: AppSettings = {
      ...(await getAppSettings()),
      serviceMode: "managed",
      onboardingCompleted: false,
    };
    let keyPresent = false;
    const transport = vi.fn(
      async (command: string, args?: { settings: AppSettings }) => {
        if (command === "get_app_settings") return settings;
        if (command === "update_app_settings") {
          const next = args!.settings;
          if (
            settings.serviceMode === "managed" &&
            next.serviceMode === "byok" &&
            !keyPresent
          )
            throw new Error("Add a Deepgram API key before switching.");
          settings = next;
          return settings;
        }
        if (command === "managed_sign_in_cancel") return;
        throw new Error(`Unexpected command: ${command}`);
      },
    );
    window.__TAURI_INTERNALS__ = { invoke: transport };
    getRecommendationProviderStatus.mockResolvedValue([
      {
        provider: "codex",
        available: true,
        credentialPresent: true,
        message: "Connected",
      },
    ]);
    try {
      await renderOnboarding(false);
      fireEvent.click(
        screen.getByRole("button", { name: "Use your own providers" }),
      );
      const input = await screen.findByLabelText("Deepgram API key");
      setTranscriptionApiKey.mockImplementationOnce(async () => {
        keyPresent = true;
        return { deepgram: true, assemblyAi: false };
      });

      expect(settings.serviceMode).toBe("managed");
      fireEvent.change(input, { target: { value: "synthetic-key" } });
      fireEvent.click(screen.getByRole("button", { name: "Save key" }));
      fireEvent.click(await screen.findByRole("button", { name: "Done" }));
      expect(settings.serviceMode).toBe("managed");
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByText("To get started, let Savvy hear the meeting.");
      expect(settings.serviceMode).toBe("byok");
    } finally {
      delete window.__TAURI_INTERNALS__;
      resetBrowserDemoState();
    }
  });

  it("keeps the managed provider path when personal setup is skipped", async () => {
    await updateAppSettings({
      ...(await getAppSettings()),
      serviceMode: "managed",
      onboardingCompleted: false,
    });
    try {
      await renderOnboarding(false);
      fireEvent.click(
        screen.getByRole("button", { name: "Use your own providers" }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Skip for now" }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Set up later" }),
      );
      await screen.findByText("To get started, let Savvy hear the meeting.");
      expect((await getAppSettings()).serviceMode).toBe("managed");
      expect(
        screen.getByText(/audio passes through Savvy to Deepgram/),
      ).toBeInTheDocument();
    } finally {
      resetBrowserDemoState();
    }
  });

  it("moves focus to each setup step without stealing focus during key entry", async () => {
    await renderOnboarding(false);
    expect(screen.getByText("Welcome to Savvy")).toHaveFocus();
    fireEvent.click(
      screen.getByRole("button", { name: "Use your own providers" }),
    );
    const title = await screen.findByText(
      "Add a transcription key so Savvy can turn speech into text.",
    );
    expect(title).toHaveFocus();
    const input = screen.getByLabelText("Deepgram API key");
    input.focus();
    fireEvent.change(input, { target: { value: "typed-key" } });
    expect(input).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await screen.findByRole("button", { name: "Set up later" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      await screen.findByText(
        "Add a transcription key so Savvy can turn speech into text.",
      ),
    ).toHaveFocus();
  });

  it("binds a saved key to the selected provider and compatible settings", async () => {
    resetBrowserDemoState();
    await renderOnboarding(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Use your own providers" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "AssemblyAI" }));
    fireEvent.change(screen.getByLabelText("AssemblyAI API key"), {
      target: { value: "assembly-secret" },
    });
    setTranscriptionApiKey.mockResolvedValueOnce({
      deepgram: false,
      assemblyAi: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await screen.findByRole("button", { name: "Done" });
    expect(setTranscriptionApiKey).toHaveBeenCalledWith(
      "assemblyAi",
      "assembly-secret",
    );
    expect(await getAppSettings()).toMatchObject({
      transcriptionProvider: "assemblyAi",
      transcriptionModel: "u3-rt-pro",
      transcriptionLanguage: "multi",
    });
    fireEvent.click(screen.getByRole("button", { name: "Deepgram" }));
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
    resetBrowserDemoState();
  });

  it("restores existing transcription settings and can select another saved key", async () => {
    await updateAppSettings({
      ...(await getAppSettings()),
      transcriptionProvider: "assemblyAi",
      transcriptionModel: "universal-streaming-english",
      transcriptionLanguage: "en",
    });
    getTranscriptionKeyStatus.mockResolvedValueOnce({
      deepgram: true,
      assemblyAi: true,
    });
    await renderOnboarding(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Use your own providers" }),
    );
    expect(await screen.findByLabelText("AssemblyAI API key")).toHaveValue("");
    expect(await getAppSettings()).toMatchObject({
      transcriptionModel: "universal-streaming-english",
      transcriptionLanguage: "en",
    });
    fireEvent.click(screen.getByRole("button", { name: /Deepgram/ }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByRole("button", { name: "Set up later" });
    expect(await getAppSettings()).toMatchObject({
      transcriptionProvider: "deepgram",
      transcriptionModel: "nova-3",
      transcriptionLanguage: "multi",
    });
    expect(setTranscriptionApiKey).not.toHaveBeenCalled();
  });

  it("clears pasted credentials on provider changes and locks selection during storage", async () => {
    resetBrowserDemoState();
    await renderOnboarding(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Use your own providers" }),
    );
    const input = await screen.findByLabelText("Deepgram API key");
    expect(
      screen.getByRole("link", { name: "Get your Deepgram API key" }),
    ).toHaveAttribute("href", "https://console.deepgram.com");
    fireEvent.change(input, { target: { value: "deepgram-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "AssemblyAI" }));
    expect(screen.getByLabelText("AssemblyAI API key")).toHaveValue("");
    expect(
      screen.getByRole("link", { name: "Get your AssemblyAI API key" }),
    ).toHaveAttribute("href", "https://www.assemblyai.com/app");
    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("AssemblyAI API key"), {
      target: { value: "assembly-secret" },
    });
    let finish!: (value: { deepgram: boolean; assemblyAi: boolean }) => void;
    setTranscriptionApiKey.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(
      screen.getByRole("button", { name: "Checking key…" }),
    ).toBeDisabled();
    expect(requestMicrophonePermission).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Deepgram" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "AssemblyAI" })).toBeDisabled();
    await act(async () => finish({ deepgram: false, assemblyAi: true }));
    resetBrowserDemoState();
  });

  it("requires a verified personal AI connection before saving the selected provider", async () => {
    resetBrowserDemoState();
    getRecommendationProviderStatus.mockResolvedValue([
      {
        provider: "codex",
        available: false,
        credentialPresent: false,
        message: "Codex CLI is not installed",
      },
      {
        provider: "claude",
        available: true,
        credentialPresent: false,
        message: "Claude Code · Not authenticated",
      },
    ]);
    getRecommendationProviderStatus.mockRejectedValueOnce(
      new Error("Provider check unavailable"),
    );
    await renderOnboarding(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Use your own providers" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Skip for now" }),
    );
    expect(await screen.findByText("Connect your AI")).toBeVisible();
    expect(
      await screen.findByText("Error: Provider check unavailable"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(getRecommendationProviderStatus).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Codex CLI is not installed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    expect(screen.getByText(/finish signing in/)).toBeVisible();
    getRecommendationProviderStatus.mockResolvedValue([
      {
        provider: "claude",
        available: true,
        credentialPresent: true,
        message: "Claude Code · Authenticated",
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("To get started, let Savvy hear the meeting.");
    expect((await getAppSettings()).recommendationProvider).toBe("claude");
    expect(requestMicrophonePermission).not.toHaveBeenCalled();
    expect(requestScreenRecordingPermission).not.toHaveBeenCalled();
    resetBrowserDemoState();
  });

  it("uses ScreenCaptureKit on an explicit recheck when preflight is stale", async () => {
    checkMicrophonePermission.mockResolvedValue(true);
    await renderOnboarding();
    await waitFor(() =>
      expect(rowButton("Screen & system audio")).toBeEnabled(),
    );
    expect(probeSystemAudioPermission).not.toHaveBeenCalled();
    probeSystemAudioPermission.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(row("Screen & system audio")).toHaveTextContent("Allowed"),
    );
    expect(row("Microphone")).toHaveTextContent("Allowed");
    expect(requestScreenRecordingPermission).not.toHaveBeenCalled();
  });

  it("offers reopening for an already allowed but still unrecognized permission", async () => {
    await renderOnboarding();
    await waitFor(() => expect(rowButton("Microphone")).toBeEnabled());
    fireEvent.click(rowButton("Microphone"));
    const reopen = await screen.findByRole("button", { name: "Reopen Savvy" });
    reopenApp.mockRejectedValueOnce(
      new Error("Stop the meeting before reopening Savvy."),
    );
    fireEvent.click(reopen);
    expect(await findErrorText()).toContain("Stop the meeting");
    expect(reopenApp).toHaveBeenCalledTimes(1);
  });

  it("blocks Continue until the microphone is allowed and says why", async () => {
    await renderOnboarding();

    await waitFor(() => expect(rowButton("Microphone")).toBeEnabled());
    const advance = screen.getByRole("button", { name: "Continue" });
    expect(advance).toBeDisabled();
    // A disabled control with no explanation strands the user. The screen has to
    // say which permission is still missing.
    expect(
      screen.getByText(/[Mm]icrophone .*(required|needed|before)/),
    ).toBeVisible();
  });

  it("does not persist managed mode when onboarding leaves during the post-authentication settings read", async () => {
    resetBrowserDemoState({ onboardingCompleted: false });
    const settings = await getAppSettings();
    let completeRead!: (value: AppSettings) => void;
    const read = vi.spyOn(appApi, "getAppSettings").mockImplementationOnce(
      () =>
        new Promise<AppSettings>((resolve) => {
          completeRead = resolve;
        }),
    );
    const { unmount } = render(<Onboarding onComplete={vi.fn()} />);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      unmount();
      await act(async () => completeRead(settings));
      expect((await getAppSettings()).serviceMode).toBe("byok");
    } finally {
      read.mockRestore();
      resetBrowserDemoState();
    }
  });

  it("does not report a completed native sign-in as cancelled while settings are pending", async () => {
    resetBrowserDemoState({ onboardingCompleted: false });
    const settings = await getAppSettings();
    let completeRead!: (value: AppSettings) => void;
    const read = vi.spyOn(appApi, "getAppSettings").mockImplementationOnce(
      () =>
        new Promise<AppSettings>((resolve) => {
          completeRead = resolve;
        }),
    );
    const cancel = vi
      .spyOn(appApi, "managedSignInCancel")
      .mockRejectedValue(
        new Error(
          "Sign-in already completed. Use Sign out to leave this account.",
        ),
      );
    const { unmount } = render(<Onboarding onComplete={vi.fn()} />);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "already completed",
      );
      expect(
        screen.getByRole("heading", { name: "Finish signing in" }),
      ).toBeVisible();
      await act(async () => completeRead(settings));
      await screen.findByRole("heading", {
        name: "To get started, let Savvy hear the meeting.",
      });
      expect((await getAppSettings()).serviceMode).toBe("managed");
    } finally {
      unmount();
      read.mockRestore();
      cancel.mockRestore();
      resetBrowserDemoState();
    }
  });

  it("requires an explicit microphone-only choice when system audio is denied and saves it before checking audio", async () => {
    await updateAppSettings({
      ...(await getAppSettings()),
      microphoneOnly: false,
    });
    checkMicrophonePermission.mockResolvedValue(true);
    await renderOnboarding();
    await waitFor(() => expect(row("Microphone")).toHaveTextContent("Allowed"));
    const advance = screen.getByRole("button", { name: "Continue" });
    expect(advance).toBeDisabled();
    const choice = screen.getByRole("checkbox", {
      name: "Use microphone only",
    });
    fireEvent.click(choice);
    expect(advance).toBeEnabled();
    fireEvent.click(choice);
    expect(advance).toBeDisabled();
    fireEvent.click(choice);
    fireEvent.click(advance);
    await screen.findByText("Audio setup");
    expect((await getAppSettings()).microphoneOnly).toBe(true);
    expect(requestScreenRecordingPermission).not.toHaveBeenCalled();
    resetBrowserDemoState();
  });

  it("locks permission choices and exit until the save settles, then allows retry", async () => {
    checkMicrophonePermission.mockResolvedValue(true);
    const onComplete = await renderOnboarding();
    await waitFor(() => expect(row("Microphone")).toHaveTextContent("Allowed"));
    const choice = screen.getByRole("checkbox", {
      name: "Use microphone only",
    });
    fireEvent.click(choice);
    let rejectSave!: (reason: Error) => void;
    const save = vi.spyOn(appApi, "updateAppSettings").mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSave = reject;
        }),
    );
    try {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(choice).toBeDisabled();
      expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Check again" }),
      ).toBeDisabled();
      const skip = screen.getByRole("button", { name: "Set up later" });
      expect(skip).toBeDisabled();
      fireEvent.click(skip);
      expect(onComplete).not.toHaveBeenCalled();
      await act(async () => rejectSave(new Error("Settings disk unavailable")));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Settings disk unavailable",
      );
      expect(choice).toBeEnabled();
      expect(choice).toBeChecked();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByText("Audio setup");
      expect(save).toHaveBeenCalledTimes(2);
      expect((await getAppSettings()).microphoneOnly).toBe(true);
    } finally {
      save.mockRestore();
    }
  });

  it("keeps both audio sources enabled when both permissions are granted", async () => {
    checkMicrophonePermission.mockResolvedValue(true);
    checkScreenRecordingPermission.mockResolvedValue(true);
    await renderOnboarding();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Audio setup");
    expect((await getAppSettings()).microphoneOnly).toBe(false);
  });

  it("flips the row to Allowed as soon as macOS reports the grant", async () => {
    await renderOnboarding();
    await waitFor(() => expect(rowButton("Microphone")).toBeEnabled());

    checkMicrophonePermission.mockResolvedValue(true);
    fireEvent.click(rowButton("Microphone"));

    await waitFor(() => expect(row("Microphone")).toHaveTextContent("Allowed"));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Use microphone only" }),
    );
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("guides the user to System Settings when the microphone stays denied", async () => {
    await renderOnboarding();
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
    await renderOnboarding();
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
    await renderOnboarding();
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
    await renderOnboarding();
    await waitFor(() => expect(rowButton("Microphone")).toBeEnabled());

    fireEvent.click(rowButton("Microphone"));

    expect(await findErrorText()).toMatch(
      /could not request microphone access/i,
    );
    expect(rowButton("Microphone")).toHaveTextContent("Allow");
  });

  it("tells the user when the permission check itself fails", async () => {
    getAppStatus.mockRejectedValue(new Error("ipc unavailable"));
    await renderOnboarding();

    expect(await findErrorText()).toMatch(/check/i);
  });

  it("explains the screen recording restart requirement and keeps it optional", async () => {
    checkMicrophonePermission.mockResolvedValue(true);
    await renderOnboarding();
    await waitFor(() =>
      expect(rowButton("Screen & system audio")).toBeEnabled(),
    );

    fireEvent.click(rowButton("Screen & system audio"));
    await exhaustPermissionPolling();

    expect(guidanceText()).toMatch(/reopen Savvy/);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Use microphone only" }),
    );
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(screen.getByText(/Savvy only hears you/)).toBeVisible();
  });

  it("lets the user dismiss an onboarding error", async () => {
    requestMicrophonePermission.mockRejectedValue(new Error("plugin missing"));
    await renderOnboarding();
    await waitFor(() => expect(rowButton("Microphone")).toBeEnabled());

    fireEvent.click(rowButton("Microphone"));
    await findErrorText();

    fireEvent.click(screen.getByRole("button", { name: /Dismiss/i }));
    expect(errorText()).toBeNull();
  });

  it("clears a stale error when the user moves to the next step", async () => {
    requestMicrophonePermission.mockRejectedValue(new Error("plugin missing"));
    await renderOnboarding();
    await waitFor(() => expect(rowButton("Microphone")).toBeEnabled());

    fireEvent.click(rowButton("Microphone"));
    await findErrorText();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Use microphone only" }),
    );
    checkMicrophonePermission.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Audio setup")).toBeVisible();
    // The permission error belongs to the step the user just left.
    expect(errorText()).toBeNull();
  });

  it("surfaces and then clears a key-storage failure", async () => {
    checkMicrophonePermission.mockResolvedValue(true);
    await renderOnboarding(false);
    fireEvent.click(
      await screen.findByRole("button", { name: "Use your own providers" }),
    );

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
    const onComplete = await renderOnboarding(false);
    fireEvent.click(
      await screen.findByRole("button", { name: "Use your own providers" }),
    );

    expect(
      await screen.findByText(/meetings cannot be transcribed/),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Set up later" }),
    );
    await screen.findByRole("heading", {
      name: "To get started, let Savvy hear the meeting.",
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Set up later" }),
    );
    expect(onComplete).toHaveBeenCalled();
  });

  it("announces onboarding errors to assistive technology", async () => {
    requestMicrophonePermission.mockRejectedValue(new Error("plugin missing"));
    await renderOnboarding();
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
    await renderOnboarding();
    await waitFor(() =>
      expect(rowButton("Screen & system audio")).toBeEnabled(),
    );

    fireEvent.click(rowButton("Screen & system audio"));
    expect(await findErrorText()).toMatch(/screen recording access/i);

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Use microphone only" }),
    );
    // Screen recording is optional, so Continue is the expected way forward.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Audio setup")).toBeVisible();
    expect(errorText()).toBeNull();
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
    probeSystemAudioPermission.mockRejectedValue(
      new Error("Screen capture is unavailable"),
    );
    reopenApp.mockResolvedValue(undefined);
  });

  afterEach(() => vi.clearAllMocks());

  it("preserves completed onboarding when macOS reports no microphone grant after an update", async () => {
    checkMicrophonePermission.mockResolvedValue(false);
    checkScreenRecordingPermission.mockResolvedValue(true);
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Prepare for your meeting" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "Set up Savvy" }),
    ).not.toBeInTheDocument();
    expect(checkMicrophonePermission).not.toHaveBeenCalled();
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
    await renderOnboarding();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    expect(row("Microphone")).toHaveTextContent("Allowed");
    expect(row("Screen & system audio")).toHaveTextContent("Allowed");
    expect(checkMicrophonePermission).not.toHaveBeenCalled();
  });
});
