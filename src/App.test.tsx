import { version } from "../package.json";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { MeetingOverlay } from "./App";
import {
  meetingEventIsStale,
  mergeTranscriptTurn,
  reduceMeetingEvent,
  startsNewMeeting,
  type GenerationCursor,
} from "./lib/meetingEvents";
import { resetBrowserDemoState } from "./lib/api";
import * as api from "./lib/api";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
import { requestPermissionDecision } from "./lib/permissions";
import type { TranscriptTurn } from "./types";

it("shows native provider validation errors without losing their message", async () => {
  const invoke = vi.fn().mockRejectedValueOnce({
    code: "invalid_key",
    message: "The provider rejected this API key.",
  });
  window.__TAURI_INTERNALS__ = { invoke };
  try {
    await expect(
      api.setTranscriptionApiKey("assemblyAi", "synthetic-key"),
    ).rejects.toThrow("The provider rejected this API key.");
    expect(invoke).toHaveBeenCalledWith(
      "set_transcription_api_key",
      {
        provider: "assemblyAi",
        apiKey: "synthetic-key",
      },
      undefined,
    );
  } finally {
    delete window.__TAURI_INTERNALS__;
  }
});

it("sends the reviewed content hash through the native start command and rejects missing review", async () => {
  const invoke = vi.fn().mockResolvedValue({ id: "test-session" });
  window.__TAURI_INTERNALS__ = { invoke };
  const expected =
    "01b76b0399cd35e10d594373c72656a3ff97533a26798293fb689aab604ff9b7";
  const digest = vi
    .fn()
    .mockResolvedValue(
      Uint8Array.from(expected.match(/../g)!, (value) =>
        Number.parseInt(value, 16),
      ).buffer,
    );
  vi.stubGlobal("crypto", { subtle: { digest } });
  try {
    const reviewed = "Reviewed brief\nNo discount\nCatalà";
    await api.startMeeting("client", "brief", reviewed);
    expect(invoke).toHaveBeenCalledWith(
      "start_meeting",
      {
        clientId: "client",
        briefId: "brief",
        expectedBriefHash: expected,
      },
      undefined,
    );
    expect(digest).toHaveBeenCalledWith(
      "SHA-256",
      new TextEncoder().encode(reviewed),
    );
    await expect(api.startMeeting("client", "brief")).rejects.toThrow(
      "Review the brief",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally {
    delete window.__TAURI_INTERNALS__;
    vi.unstubAllGlobals();
  }
});

describe("App", () => {
  beforeEach(() => {
    resetBrowserDemoState();
    window.history.replaceState({}, "", "/");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete window.__TAURI_INTERNALS__;
    window.history.replaceState({}, "", "/");
  });

  it.each([false, true])(
    "recovers dashboard initialization in overlay=%s",
    async (overlay) => {
      const snapshot = await api.getDashboard();
      if (overlay) {
        snapshot.activeSession = await api.startMeeting(null, null);
        window.history.replaceState({}, "", "/?overlay=1");
      }
      let resolve!: (value: typeof snapshot) => void;
      const load = vi
        .spyOn(api, "getDashboard")
        .mockRejectedValueOnce(new Error("Storage temporarily unavailable"))
        .mockRejectedValueOnce(new Error("Still unavailable"))
        .mockImplementationOnce(
          () =>
            new Promise((yes) => {
              resolve = yes;
            }),
        );
      render(<App />);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Storage temporarily unavailable",
      );
      fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Still unavailable",
      );
      fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
      expect(
        screen.queryByRole("button", { name: "Retry loading" }),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("Loading")).toBeVisible();
      await act(async () => resolve(snapshot));
      expect(load).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      if (overlay)
        expect(
          await screen.findByRole("button", {
            name: "Keep recommendation open",
          }),
        ).toBeVisible();
      else
        expect(
          await screen.findByRole("button", { name: "Regenerate" }),
        ).toBeVisible();
    },
  );

  it.each(["cancelled", "completed"] as const)(
    "keeps the brief busy until native cleanup and handles %s",
    async (outcome) => {
      const completed = await api.generateBriefDraft(null, "Completed request");
      let resolve!: (brief: typeof completed) => void;
      let reject!: (error: Error) => void;
      const generation = vi.spyOn(api, "generateBriefDraft").mockImplementation(
        () =>
          new Promise((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      );
      const cancel = vi.spyOn(api, "cancelBriefDraft").mockResolvedValue();
      const progress = vi
        .spyOn(api, "getBriefProgress")
        .mockResolvedValue("reading");
      render(<App />);
      fireEvent.click(
        await screen.findByRole("button", { name: "Regenerate" }),
      );
      const button = await screen.findByRole("button", {
        name: "Cancel brief generation",
      });
      expect(
        screen.queryByText("Complete", { exact: true }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Preparing your brief" }),
      ).toHaveFocus();
      progress.mockResolvedValue("drafting");
      await screen.findByText("Complete", { exact: true });
      fireEvent.click(button);
      await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
      const [clientId, , requestId] = generation.mock.calls[0];
      expect(requestId).toEqual(expect.any(String));
      expect(cancel).toHaveBeenCalledWith(clientId, requestId);
      expect(button).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Regenerate", hidden: true }),
      ).toBeDisabled();
      await act(async () => {
        if (outcome === "cancelled")
          reject(new Error("brief_cancelled: Brief generation was cancelled."));
        else resolve(completed);
      });
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Cancel brief generation" }),
        ).not.toBeInTheDocument(),
      );
      if (outcome === "completed") {
        expect(
          screen.getByRole("heading", { name: "Your meeting brief" }),
        ).toHaveFocus();
        fireEvent.click(screen.getByRole("button", { name: "Edit context" }));
      }
      expect(screen.getByRole("button", { name: "Regenerate" })).toBeEnabled();
      if (outcome === "cancelled")
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Brief generation was cancelled.",
        );
      else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("reviews refreshed source, retains it after file failure and never starts from review", async () => {
    const snapshot = await api.getDashboard();
    const brief = snapshot.activeBrief;
    if (!brief) throw new Error("Expected demo brief");
    const refresh = vi
      .spyOn(api, "refreshBriefFromDocument")
      .mockResolvedValue({
        ...brief,
        id: `${brief.id}-refreshed`,
        objective: "Obsolete structured objective",
        documentContent:
          "## Objective\nCurrent file objective\n## Questions to ask\n- Current question?\n## Risks\n- Current guardrail",
      });
    const start = vi.spyOn(api, "startMeeting");
    const open = vi
      .spyOn(api, "openBriefDocument")
      .mockRejectedValue(new Error("File is missing"));
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Review brief" }),
    );
    expect(
      screen.getByRole("heading", { name: "Your meeting brief" }),
    ).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Refresh from file" }));
    const content = () =>
      within(screen.getByRole("region", { name: "Meeting brief" }));
    await waitFor(() =>
      expect(content().getByText("Current file objective")).toBeVisible(),
    );
    expect(content().getByText("Current question?")).toBeVisible();
    expect(content().getByText("Current guardrail")).toBeVisible();
    expect(
      content().queryByText("Obsolete structured objective"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open full brief" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "File is missing",
    );
    expect(open).toHaveBeenCalledWith(`${brief.id}-refreshed`);
    refresh.mockRejectedValue(new Error("Cannot read file"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh from file" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Cannot read file"),
    );
    expect(content().getByText("Current file objective")).toBeVisible();
    expect(start).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "Check readiness" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Check readiness" }));
    await screen.findByRole("button", { name: "Start meeting" });
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Check readiness" }),
      ).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit context" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Prepare for your meeting" }),
      ).toHaveFocus(),
    );
  });

  it("uses the meeting objective for this brief without changing the reusable prompt", async () => {
    const settings = await api.getAppSettings();
    const generate = vi
      .spyOn(api, "generateBriefDraft")
      .mockRejectedValue(new Error("Supplier unavailable"));
    const start = vi.spyOn(api, "startMeeting");
    render(<App />);
    const objective = await screen.findByLabelText("Meeting objective");
    fireEvent.change(objective, {
      target: { value: "Agree on renewal dates" },
    });
    const prepare = screen.getByRole("button", {
      name: "Prepare brief",
    });
    await waitFor(() => expect(prepare).toBeEnabled());
    fireEvent.click(prepare);
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(generate.mock.calls[0][1]).toBe(
      `${settings.briefGenerationPrompt}\n\nMeeting objective: Agree on renewal dates`,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Meeting objective")).toHaveValue(
        "Agree on renewal dates",
      ),
    );
    expect((await api.getAppSettings()).briefGenerationPrompt).toBe(
      settings.briefGenerationPrompt,
    );
    fireEvent.click(screen.getByRole("button", { name: "Prepare brief" }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(generate.mock.calls[1][1]).toBe(generate.mock.calls[0][1]);
    expect(start).not.toHaveBeenCalled();
  });

  it("announces document read failure and retries without losing keyboard focus", async () => {
    const dashboard = await api.getDashboard();
    const documents = await api.listClientDocuments(dashboard.clients[0].id);
    let finish!: (value: typeof documents) => void;
    const read = vi
      .spyOn(api, "listClientDocuments")
      .mockRejectedValueOnce(new Error("Folder temporarily unreadable"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const save = vi.spyOn(api, "setClientDocumentSelection");
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Show documents" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Folder temporarily unreadable",
    );
    const retry = screen.getByRole("button", {
      name: "Retry reading documents",
    });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Reading folder…")).toHaveAttribute(
      "role",
      "status",
    );
    expect(retry).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(retry);
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => finish(documents));
    expect(
      screen.queryByText("Folder temporarily unreadable"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh documents" })).toBe(
      retry,
    );
    expect(retry).toHaveFocus();
    expect(
      screen.getByRole("checkbox", { name: /msa-2024-signed\.pdf/ }),
    ).toBeChecked();
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps confirmed exclusions while a refreshed document list is delayed or stale", async () => {
    const dashboard = await api.getDashboard();
    const documents = await api.listClientDocuments(dashboard.clients[0].id);
    let finish!: (value: typeof documents) => void;
    const read = vi
      .spyOn(api, "listClientDocuments")
      .mockResolvedValueOnce(documents)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Show documents" }),
    );
    const selection = await screen.findByRole("checkbox", {
      name: /q2-usage-export\.csv/,
    });
    fireEvent.click(selection);
    await waitFor(() => expect(selection).not.toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: "Refresh documents" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(selection).not.toBeChecked();
    await act(async () => finish(documents));
    expect(
      screen.getByRole("checkbox", { name: /q2-usage-export\.csv/ }),
    ).not.toBeChecked();
  });

  it("blocks assistance across navigation while context selection is pending or failed, then retries", async () => {
    const saveOriginal = api.setClientDocumentSelection;
    let reject!: (reason: Error) => void;
    const save = vi
      .spyOn(api, "setClientDocumentSelection")
      .mockImplementationOnce(
        () =>
          new Promise((_, no) => {
            reject = no;
          }),
      );
    const generate = vi.spyOn(api, "generateBriefDraft");
    const start = vi.spyOn(api, "startMeeting");
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Show documents" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Select none" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("button", { name: "Prepare brief" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Check readiness" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: /msa-2024-signed\.pdf/ }),
    ).toBeChecked();
    await act(async () => reject(new Error("Selection could not be saved")));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Selection could not be saved",
    );
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    fireEvent.keyDown(window, { key: "m", metaKey: true, shiftKey: true });
    expect(
      screen.queryByRole("button", { name: "Start meeting" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    expect(
      screen.getByRole("button", { name: "Prepare brief" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Check readiness" }),
    ).toBeDisabled();
    save.mockImplementation(saveOriginal);
    fireEvent.click(
      screen.getByRole("button", { name: "Retry context selection" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Prepare brief" }),
      ).toBeEnabled(),
    );
    expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
    expect(
      screen.queryByRole("button", { name: "Retry context selection" }),
    ).not.toBeInTheDocument();
    expect(generate).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("ignores a stale preparation read after confirming a new document selection", async () => {
    const dashboard = await api.getDashboard();
    const snapshot = await api.getPreparationSnapshot(dashboard.clients[0].id);
    let resolveOld!: (value: typeof snapshot) => void;
    vi.spyOn(api, "getPreparationSnapshot")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValue(snapshot);
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Show documents" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Select none" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Prepare brief" }),
      ).toBeEnabled(),
    );
    expect(screen.getByRole("button", { name: "Review brief" })).toBeVisible();
    await act(async () => resolveOld({ ...snapshot, brief: null }));
    expect(screen.getByRole("button", { name: "Review brief" })).toBeVisible();
  });

  it("does not open readiness or drop the selected brief while preparation is loading", async () => {
    const snapshot = await api.getDashboard();
    const preparation = await api.getPreparationSnapshot(
      snapshot.clients[0].id,
    );
    let finish!: (value: typeof preparation) => void;
    vi.spyOn(api, "getPreparationSnapshot").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const start = vi.spyOn(api, "startMeeting");
    render(<App />);
    const button = await screen.findByRole("button", {
      name: "Check readiness",
    });
    expect(button).toBeDisabled();
    fireEvent.keyDown(window, { key: "m", metaKey: true, shiftKey: true });
    expect(
      screen.queryByRole("button", { name: "Start meeting" }),
    ).not.toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
    await act(async () => finish(preparation));
    await waitFor(() => expect(button).toBeEnabled());
    expect(start).not.toHaveBeenCalled();
  });

  it("requires every source page and resets approval when the file changes", async () => {
    const snapshot = await api.getDashboard();
    const preparation = await api.getPreparationSnapshot(
      snapshot.clients[0].id,
    );
    if (!preparation.brief) throw new Error("Expected fixture brief");
    const brief = {
      ...preparation.brief,
      documentContent: "x".repeat(12000) + "Unseen tail instruction",
    };
    vi.spyOn(api, "getPreparationSnapshot").mockResolvedValue({
      ...preparation,
      brief,
    });
    vi.spyOn(api, "refreshBriefFromDocument").mockResolvedValue({
      ...brief,
      documentContent: brief.documentContent + " changed",
    });
    const start = vi.spyOn(api, "startMeeting");
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Review brief" }),
    );
    const readiness = () =>
      screen.getByRole("button", { name: "Check readiness" });
    expect(readiness()).toBeDisabled();
    expect(
      screen.queryByText("Unseen tail instruction"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Unseen tail instruction")).toBeVisible();
    expect(screen.getByRole("region", { name: "Meeting brief" })).toHaveFocus();
    expect(readiness()).toBeEnabled();
    fireEvent.click(readiness());
    await screen.findByRole("button", { name: "Start meeting" });
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh from file" }));
    await waitFor(() => expect(readiness()).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Edit context" }));
    fireEvent.keyDown(window, { key: "m", metaKey: true, shiftKey: true });
    await screen.findByRole("heading", { name: "Your meeting brief" });
    expect(
      screen.queryByRole("button", { name: "Start meeting" }),
    ).not.toBeInTheDocument();
    expect(readiness()).toBeDisabled();
    expect(start).not.toHaveBeenCalled();
  });

  it("pins the brief at readiness even if preparation refreshes before start", async () => {
    const snapshot = await api.getDashboard();
    const client = snapshot.clients[0];
    const preparation = await api.getPreparationSnapshot(client.id);
    if (!preparation.brief) throw new Error("Expected fixture brief");
    const read = vi
      .spyOn(api, "getPreparationSnapshot")
      .mockResolvedValue(preparation);
    const dashboard = vi.spyOn(api, "getDashboard").mockResolvedValue(snapshot);
    const start = vi.spyOn(api, "startMeeting");
    render(<App />);
    await screen.findByRole("button", { name: "Review brief" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Check readiness" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check readiness" }));
    await screen.findByRole("heading", { name: "Your meeting brief" });
    expect(
      screen.queryByRole("button", { name: "Start meeting" }),
    ).not.toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check readiness" }));
    await screen.findByRole("button", { name: "Start meeting" });
    read.mockResolvedValue({
      ...preparation,
      brief: {
        ...preparation.brief,
        documentContent: "Changed after readiness",
      },
    });
    dashboard.mockResolvedValue({
      ...snapshot,
      clients: [...snapshot.clients, { ...client, id: "another-client" }],
    });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Start meeting" }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith(
        client.id,
        preparation.brief?.id,
        preparation.brief?.documentContent,
      ),
    );
  });

  it("keeps an idle overlay unmounted and applies saved settings from the main window", async () => {
    const snapshot = await api.getDashboard();
    const settings = await api.getAppSettings();
    const preparation = await api.getPreparationSnapshot(null);
    vi.spyOn(api, "getDashboard").mockResolvedValue(snapshot);
    vi.spyOn(api, "getAppSettings").mockResolvedValue(settings);
    vi.spyOn(api, "getAppStatus").mockResolvedValue({
      version: "0.1.1",
      platform: "macos",
    });
    vi.spyOn(api, "getPreparationSnapshot").mockResolvedValue(preparation);
    const meter = vi.spyOn(api, "getAudioLevel");
    vi.mocked(listen).mockResolvedValue(vi.fn());
    window.__TAURI_INTERNALS__ = {};
    window.history.replaceState({}, "", "/?overlay=1");
    const view = render(<App />);
    await waitFor(() =>
      expect(listen).toHaveBeenCalledWith(
        "savvy://settings-changed",
        expect.any(Function),
      ),
    );
    const handler = vi
      .mocked(listen)
      .mock.calls.find(([name]) => name === "savvy://settings-changed")![1];
    act(() =>
      handler({
        event: "savvy://settings-changed",
        id: 1,
        payload: { ...settings, theme: "dark" },
      }),
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(view.container.querySelector(".ov-stage")).toBeNull();
    expect(meter).not.toHaveBeenCalled();
    view.unmount();
  });

  it("bounds microphone polling and stops it on visibility changes, pause, and unmount", async () => {
    const session = await api.startMeeting(null, null);
    const props = {
      session,
      turns: [],
      recommendation: null,
      onTogglePause: vi.fn(),
      onRequestRecommendation: vi.fn(),
      onStop: vi.fn(),
      busy: false,
      error: null,
      style: "live" as const,
      position: "bottom" as const,
      showTranscript: false,
      thinking: null,
      hasNotes: false,
    };
    vi.useFakeTimers();
    let resolveLevel!: (value: number) => void;
    const meter = vi.spyOn(api, "getAudioLevel").mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLevel = resolve;
      }),
    );
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const view = render(<MeetingOverlay {...props} />);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(meter).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveLevel(0.1);
    });
    hidden.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(meter).toHaveBeenCalledTimes(1);
    meter.mockRejectedValueOnce(new Error("Microphone disconnected"));
    hidden.mockReturnValue(false);
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Microphone disconnected",
    );
    meter.mockResolvedValue(0.1);
    await act(() => vi.advanceTimersByTimeAsync(80));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.rerender(
      <MeetingOverlay {...props} session={{ ...session, state: "paused" }} />,
    );
    const calls = meter.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(meter).toHaveBeenCalledTimes(calls);
    view.rerender(<MeetingOverlay {...props} stopped />);
    expect(screen.getByText("Meeting stopped")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Unmute microphone" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop meeting" })).toBeEnabled();
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(meter).toHaveBeenCalledTimes(calls);
  });

  it("tombstones cancelled opportunity results", () => {
    expect(
      meetingEventIsStale(
        {
          type: "recommendationCompleted",
          sessionId: "meeting",
          sequence: 4,
          generationId: 4,
          transcriptRevision: 8,
          recommendation: {} as never,
        },
        {
          sessionId: "meeting",
          sequence: 3,
          generationId: 4,
          terminalGenerationId: 4,
        },
      ),
    ).toBe(true);
  });

  it("accepts a completed recommendation overtaken by transcript events", () => {
    expect(
      meetingEventIsStale(
        {
          type: "recommendationCompleted",
          sessionId: "meeting",
          sequence: 4,
          generationId: 1,
          transcriptRevision: 2,
          recommendation: {} as never,
        },
        { sessionId: "meeting", sequence: 5, generationId: 1 },
      ),
    ).toBe(false);
  });

  describe("reduceMeetingEvent", () => {
    const cursor: GenerationCursor = {
      sessionId: "meeting",
      generationId: 1,
      sequence: 3,
      terminalGenerationId: 1,
      trigger: null,
    };
    const started = (
      trigger: "question" | "opportunity" | "manual",
      generationId = 2,
    ) =>
      ({
        type: "recommendationStarted",
        sessionId: "meeting",
        sequence: 4,
        generationId,
        transcriptRevision: 9,
        trigger,
        local: null,
      }) as const;

    it("shows a scan as checking notes without touching the current card", () => {
      const effect = reduceMeetingEvent(cursor, started("opportunity"));
      expect(effect.kind).toBe("started");
      if (effect.kind !== "started") return;
      expect(effect.thinking).toEqual({
        trigger: "opportunity",
        generationId: 2,
        phase: "checking",
      });
      expect(effect.card).toBeUndefined();
      expect(effect.cursor.generationId).toBe(2);
    });

    it("starts explicit triggers in the checking phase with their local card", () => {
      const effect = reduceMeetingEvent(cursor, started("question"));
      expect(effect.kind).toBe("started");
      if (effect.kind !== "started") return;
      expect(effect.thinking).toEqual({
        trigger: "question",
        generationId: 2,
        phase: "checking",
      });
      expect(effect.card).toBeNull();
    });

    it("moves to the thinking phase on the model's first token, once per generation", () => {
      const running = reduceMeetingEvent(cursor, started("question"));
      if (running.kind !== "started") throw new Error("expected start");
      const thinkingEvent = {
        type: "recommendationThinking",
        sessionId: "meeting",
        sequence: 5,
        generationId: 2,
        transcriptRevision: 9,
      } as const;
      const effect = reduceMeetingEvent(running.cursor, thinkingEvent);
      expect(effect.kind).toBe("phase");
      if (effect.kind !== "phase") return;
      expect(effect.generationId).toBe(2);
      expect(effect.cursor.generationId).toBe(2);
      expect(effect.cursor.sequence).toBe(5);
      expect(
        reduceMeetingEvent(effect.cursor, { ...thinkingEvent, generationId: 1 })
          .kind,
      ).toBe("ignored");
    });

    it("ends thinking on any terminal event, including cancellation", () => {
      const running = reduceMeetingEvent(cursor, started("question"));
      if (running.kind !== "started") throw new Error("expected start");
      const effect = reduceMeetingEvent(running.cursor, {
        type: "recommendationCancelled",
        sessionId: "meeting",
        sequence: 5,
        generationId: 2,
        transcriptRevision: 9,
      });
      expect(effect.kind).toBe("finished");
      if (effect.kind !== "finished") return;
      expect(effect.recommendation).toBeNull();
      expect(effect.cursor.terminalGenerationId).toBe(2);
      expect(
        reduceMeetingEvent(effect.cursor, started("question", 2)).kind,
      ).toBe("ignored");
    });

    it("forgets thinking when another meeting's transcript arrives", () => {
      const effect = reduceMeetingEvent(cursor, {
        type: "transcript",
        sessionId: "other",
        sequence: 1,
        turn: {} as never,
        interim: false,
      });
      expect(effect.kind).toBe("transcript");
      if (effect.kind !== "transcript") return;
      expect(effect.newSession).toBe(true);
      expect(effect.cursor.generationId).toBe(0);
    });
  });

  it("clears live state only when a different meeting starts", () => {
    expect(
      startsNewMeeting({ id: "next", state: "recording" }, "previous"),
    ).toBe(true);
    expect(startsNewMeeting({ id: "next", state: "paused" }, "next")).toBe(
      false,
    );
    expect(
      startsNewMeeting({ id: "next", state: "completed" }, "previous"),
    ).toBe(false);
  });

  it("keeps completed transcript phrases while replacing interim speech", () => {
    const turn = (id: string, text: string, isFinal: boolean) =>
      ({ id, text, isFinal, channel: "other" }) as never;
    const turns = mergeTranscriptTurn(
      [turn("final", "hello", true), turn("old", "how", false)],
      turn("new", "how are you", false),
    );
    expect(turns.map(({ text }) => text)).toEqual(["hello", "how are you"]);
  });

  it("bounds live transcript history by count and UTF-8 bytes while retaining recent turns", () => {
    const turn = (index: number, text = "word"): TranscriptTurn => ({
      id: String(index),
      sessionId: "meeting",
      channel: "unknown",
      text,
      language: "en",
      startMs: index,
      endMs: index + 1,
      isFinal: true,
      confidence: 1,
    });
    let turns: TranscriptTurn[] = [];
    for (let index = 0; index < 1000; index++) {
      turns = mergeTranscriptTurn(turns, turn(index));
    }
    expect(turns).toHaveLength(256);
    expect(turns[0].id).toBe("744");
    expect(turns[turns.length - 1]?.id).toBe("999");
    turns = [];
    for (let index = 0; index < 100; index++) {
      turns = mergeTranscriptTurn(turns, turn(index, "語".repeat(2000)));
    }
    expect(
      turns.reduce(
        (bytes, item) => bytes + new TextEncoder().encode(item.text).length,
        0,
      ),
    ).toBeLessThanOrEqual(256 * 1024);
    expect(turns[turns.length - 1]?.id).toBe("99");
    expect(turns[0].id).not.toBe("0");
    expect(mergeTranscriptTurn(turns, turn(100, "語".repeat(3000)))).toEqual(
      turns,
    );
    const longSpeech = "word ".repeat(1000);
    expect(
      mergeTranscriptTurn(
        [{ ...turn(1, longSpeech), channel: "selfSpeaker" }],
        { ...turn(2, longSpeech + "different"), channel: "other" },
      ),
    ).toHaveLength(2);
  });

  it("keeps system audio and removes its microphone echo", () => {
    const turn = (
      id: string,
      channel: "selfSpeaker" | "other",
      text: string,
      startMs: number,
    ) =>
      ({
        id,
        sessionId: "meeting",
        channel,
        text,
        startMs,
        endMs: startMs + 2_000,
        isFinal: true,
      }) as never;
    const microphone = turn(
      "microphone",
      "selfSpeaker",
      "I can start from my end",
      1_000,
    );
    const system = turn("system", "other", "I can start from my end.", 1_800);
    expect(mergeTranscriptTurn([microphone], system)).toEqual([system]);

    const local = turn("local", "selfSpeaker", "My separate update", 2_000);
    expect(mergeTranscriptTurn([local], system)).toHaveLength(2);
  });

  it("does not repeat a finalized prefix in cumulative interim speech", () => {
    const final: TranscriptTurn = {
      id: "final",
      sessionId: "meeting",
      channel: "selfSpeaker",
      text: "This is a test of the recommendation engine.",
      language: "en",
      startMs: 1_000,
      endMs: 3_000,
      isFinal: true,
      confidence: 0.9,
    };
    const interim = {
      ...final,
      id: "interim",
      text: "This is a test of the recommendation engine working correctly",
      endMs: 4_000,
      isFinal: false,
    };

    expect(
      mergeTranscriptTurn([final], interim).map(({ text }) => text),
    ).toEqual([final.text, "working correctly"]);
  });

  it("polls until macOS reports a permission grant", async () => {
    vi.useFakeTimers();
    try {
      const check = vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const result = requestPermissionDecision(vi.fn(), check);

      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toBe(true);
      expect(check).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows one grounded preparation workspace", async () => {
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Prepare for your meeting" }),
    ).toBeVisible();
    expect(
      screen.queryByText(/Ready with Northstar Health/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.queryByRole("button", { name: "Brief" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Context" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Client raw material")).not.toBeInTheDocument();
    // The "Ready with" readiness card is gone; the workspace states readiness through
    // the context selector and the brief section itself.
    expect(screen.queryByText("READY WITH")).not.toBeInTheDocument();
    expect(screen.getAllByText("General guidelines")).toHaveLength(1);
    expect(screen.queryByText("Guidance Library")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Conversation language" }),
    ).toHaveTextContent("Auto Detect");
    expect(
      screen.queryByRole("button", { name: /Manage sources/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show documents" }));
    expect(
      await screen.findByRole("checkbox", { name: /msa-2024-signed\.pdf/ }),
    ).toBeChecked();
    const unsupported = screen.getByRole("checkbox", {
      name: /roadmap\.sketch/,
    });
    expect(unsupported).toBeDisabled();
    expect(unsupported).not.toBeChecked();
    const finance = screen.getByRole("checkbox", { name: "Finance folder" });
    expect(finance).toBeChecked();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /q2-usage-export\.csv/ }),
    );
    expect(
      await screen.findByText("23 of 24 documents selected"),
    ).toBeVisible();
    await waitFor(() => expect(finance).not.toBeChecked());
    expect(screen.getByText("0 of 1")).toBeVisible();
    fireEvent.click(finance);
    expect(await screen.findByText("24 source documents")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Open client folder/ }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Remove client/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /General guidelines/ }));
    expect(screen.getByRole("button", { name: "Change…" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Clear guidance folder" }),
    ).toBeVisible();
    expect(screen.getByText("Guidance", { selector: "small" })).toBeVisible();
    expect(screen.queryByText("Live recommendation")).not.toBeInTheDocument();
    expect(
      (await screen.findAllByText("Enterprise renewal")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByLabelText("Savvy")).toHaveTextContent("savvy");
  });

  it("opens the live meeting surface without development controls", async () => {
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Prepare for your meeting" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Check readiness" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check readiness" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Check readiness" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Start meeting" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Live transcript" }),
    ).toBeVisible();
    expect(document.querySelectorAll(".swave i")).toHaveLength(9);
    expect(document.querySelector(".scard")).not.toHaveClass("ai-open");
    expect(screen.getByText("Savvy is listening")).toBeVisible();
    expect(document.querySelector(".mascot-state.listening")).toBeVisible();
    expect(screen.queryByText("Live recommendation")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Get recommendation now" }),
    ).not.toBeInTheDocument();

    expect(screen.queryByLabelText("Transcript turn")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(
      await screen.findByRole("button", { name: "Unmute microphone" }),
    ).toBeVisible();
    expect(document.querySelector(".mascot-state.muted")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Unmute microphone" }));
    expect(
      await screen.findByRole("button", { name: "Mute microphone" }),
    ).toBeVisible();
    expect(document.querySelector(".mascot-state.listening")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Stop meeting" }));
    expect(
      screen.getByText(/Savvy will stop capturing the transcript/),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Keep listening" }),
    ).toBeVisible();
    fireEvent.click(screen.getAllByRole("button", { name: "Stop meeting" })[0]);
    expect(await screen.findByText("Meeting history")).toBeVisible();
  });

  it("says what it is thinking about and disables Advice meanwhile", () => {
    render(
      <MeetingOverlay
        session={
          {
            id: "meeting",
            state: "recording",
            startedAt: new Date().toISOString(),
          } as never
        }
        turns={[
          {
            id: "turn",
            channel: "other",
            text: "We discussed the implementation timeline.",
            isFinal: true,
          } as never,
        ]}
        recommendation={null}
        onTogglePause={() => undefined}
        onRequestRecommendation={() => undefined}
        onStop={() => undefined}
        busy={false}
        error={null}
        style="live"
        position="bottom"
        showTranscript={false}
        thinking={{ trigger: "question", phase: "thinking" }}
        hasNotes
      />,
    );

    expect(screen.getByText("Answering their question")).toBeVisible();
    expect(document.querySelector(".mascot-state.thinking")).toBeVisible();
    const advice = screen.getByRole("button", {
      name: "Get recommendation now",
    });
    expect(advice).toBeDisabled();
    expect(advice).not.toHaveTextContent("Advice");
  });

  it("says it is reading the conversation when there are no notes to check", () => {
    const overlay = (hasNotes: boolean) => (
      <MeetingOverlay
        session={{ id: "meeting", state: "recording" } as never}
        turns={[]}
        recommendation={null}
        onTogglePause={() => undefined}
        onRequestRecommendation={() => undefined}
        onStop={() => undefined}
        busy={false}
        error={null}
        style="live"
        position="bottom"
        showTranscript={false}
        thinking={{ trigger: "opportunity", phase: "checking" }}
        hasNotes={hasNotes}
      />
    );
    const { rerender } = render(overlay(false));
    expect(screen.getByText("Reading the conversation")).toBeVisible();
    rerender(overlay(true));
    expect(screen.getByText("Checking notes")).toBeVisible();
  });

  it("starts a meeting with general guidelines and no client brief", async () => {
    render(<App />);
    const context = await screen.findByRole("button", {
      name: "Meeting context",
    });
    fireEvent.click(context);
    fireEvent.click(
      screen.getByRole("option", { name: /General guidelines only/ }),
    );
    expect(await screen.findByText("General guidelines only")).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Check readiness" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check readiness" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Start meeting" }),
    );
    expect(await screen.findByText("Savvy is listening")).toBeVisible();
  });

  it("removes a recommendation when its Keep countdown completes", async () => {
    const snapshot = await api.getDashboard();
    vi.spyOn(api, "getDashboard").mockResolvedValue({
      ...snapshot,
      activeSession: await api.startMeeting(null, null),
    });
    window.history.replaceState({}, "", "/?overlay=1");
    render(<App />);

    const keep = await screen.findByRole("button", {
      name: "Keep recommendation open",
    });
    expect(keep).toHaveTextContent("Keep");
    expect(keep.getAttribute("style")).toContain(
      "--recommendation-lifetime: 30000ms",
    );
    expect(keep.getAttribute("style")).not.toContain("elapsed");
    expect(screen.getByText("Say").closest(".say-block")).toHaveTextContent(
      "87% grounded",
    );
    expect(document.querySelector(".recommendation-top")).not.toHaveTextContent(
      "87% grounded",
    );

    fireEvent.animationEnd(keep, {
      animationName: "recommendation-expiry",
    });
    expect(screen.queryByText("Live recommendation")).not.toBeInTheDocument();
    window.history.replaceState({}, "", "/");
  });

  it("can keep a recommendation until it is manually dismissed", async () => {
    const snapshot = await api.getDashboard();
    vi.spyOn(api, "getDashboard").mockResolvedValue({
      ...snapshot,
      activeSession: await api.startMeeting(null, null),
    });
    window.history.replaceState({}, "", "/?overlay=1");
    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Keep recommendation open" }),
    );
    const dismiss = screen.getByRole("button", {
      name: "Dismiss recommendation",
    });
    expect(dismiss).toHaveTextContent("Dismiss");
    expect(dismiss).not.toHaveClass("auto-dismiss");
    fireEvent.animationEnd(dismiss);
    expect(screen.getByText("Live recommendation")).toBeVisible();
    fireEvent.click(dismiss);
    expect(screen.queryByText("Live recommendation")).not.toBeInTheDocument();
    window.history.replaceState({}, "", "/");
  });

  it("keeps history and its modal available after local file or deletion failure", async () => {
    vi.spyOn(api, "openMeetingTranscript").mockRejectedValue(
      new Error("Transcript file is missing"),
    );
    vi.spyOn(api, "openRecordingsFolder").mockRejectedValue(
      new Error("Recordings folder is unavailable"),
    );
    let rejectDeletion!: (error: Error) => void;
    const remove = vi.spyOn(api, "deleteMeeting").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectDeletion = reject;
        }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Show transcript file" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Transcript file is missing",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open recordings" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Recordings folder is unavailable",
      ),
    );
    const trigger = screen.getByRole("button", { name: "Delete meeting" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    const modal = screen.getByRole("dialog", { name: "Delete meeting?" });
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent(modal, new Event("cancel", { cancelable: true }));
    expect(modal).toBeVisible();
    await act(async () =>
      rejectDeletion(new Error("Could not remove recording")),
    );
    expect(await within(modal).findByRole("alert")).toHaveTextContent(
      "Could not remove recording",
    );
    expect(remove).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(trigger).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Show transcript file" }),
    ).toBeVisible();
  });

  it("keeps meeting history compact and can delete the whole meeting", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    expect(
      await screen.findByRole("button", { name: "Show transcript file" }),
    ).toBeVisible();
    expect(
      screen.queryByText("Can we make the first-year payment easier?"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/If first-year budget is the constraint/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Say")).not.toBeInTheDocument();
    expect(screen.queryByText("Avoid")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Play recording" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Delete meeting" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete meeting" }));
    expect(
      screen.getByRole("dialog", { name: "Delete meeting?" }),
    ).toBeVisible();
    expect(screen.getByText("Are you sure?")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete meeting" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect(
      await screen.findByText("Your recordings stay on this Mac"),
    ).toBeVisible();
  });

  it("onboards a new install and does not repeat it afterwards", async () => {
    resetBrowserDemoState({ onboardingCompleted: false });
    const { unmount } = render(<App />);

    // A fresh install lands on setup, not the workspace.
    expect(
      await screen.findByRole("dialog", { name: "Set up Savvy" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Prepare for your meeting" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole("button", { name: "Use your own providers" }),
    );
    expect(
      await screen.findByRole("button", { name: "Skip for now" }),
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

    expect(
      await screen.findByRole("heading", { name: "Prepare for your meeting" }),
    ).toBeVisible();
    unmount();

    // Completion is persisted, so a relaunch goes straight to the workspace.
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Prepare for your meeting" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "Set up Savvy" }),
    ).not.toBeInTheDocument();
  }, 15_000);

  it("can remove the brief so a meeting runs with none at all", async () => {
    const confirm = vi.spyOn(window, "confirm").mockImplementation(() => true);
    try {
      render(<App />);
      // The demo brief belongs to the client scope, so select the client first.
      fireEvent.click(
        await screen.findByRole("button", { name: "Meeting context" }),
      );
      fireEvent.click(await screen.findByRole("option", { name: /Northstar/ }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Unselect brief" }),
      );

      // Removing it must leave the scope with no brief, not fall back to an
      // earlier version.
      await waitFor(() => {
        expect(
          screen.queryByRole("button", { name: "More brief actions" }),
        ).not.toBeInTheDocument();
      });
      expect(confirm).toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  }, 15_000);

  it.each([false, true])(
    "restores shortcut registration across unmount, resolved=%s",
    async (resolved) => {
      let activate!: () => void;
      const capture = vi
        .spyOn(api, "setShortcutRecording")
        .mockImplementation((active) =>
          active
            ? new Promise<void>((done) => {
                activate = done;
              })
            : Promise.resolve(),
        );
      const view = render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "General" }));
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Change start listening shortcut",
        }),
      );
      if (resolved) await act(async () => activate());
      view.unmount();
      if (!resolved) await act(async () => activate());
      expect(capture.mock.calls.filter(([active]) => !active)).toHaveLength(1);
    },
  );

  it("groups the general settings into labelled sections", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "General" }));

    expect(await screen.findByText("Start Listening")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Microphone" }),
    ).toHaveTextContent("System default");
    expect(
      screen.getByRole("button", { name: "Change start listening shortcut" }),
    ).toHaveTextContent("⌘ ⇧ M");
    expect(screen.queryByText("Push To Talk")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Change start listening shortcut" }),
      );
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Change start listening shortcut",
        }),
      ).toHaveTextContent("Press keys…"),
    );
    fireEvent.keyDown(window, {
      key: "Meta",
      code: "MetaLeft",
      metaKey: true,
    });
    fireEvent.keyDown(window, {
      key: "K",
      code: "KeyK",
      metaKey: true,
      shiftKey: true,
    });
    fireEvent.keyUp(window, {
      key: "K",
      code: "KeyK",
      metaKey: true,
      shiftKey: true,
    });
    fireEvent.keyUp(window, { key: "Meta", code: "MetaLeft" });
    await waitFor(
      () =>
        expect(
          screen.getByRole("button", {
            name: "Change start listening shortcut",
          }),
        ).toHaveTextContent("⌘ ⇧ K"),
      { timeout: 3_000 },
    );
    const startListeningInfo = screen.getByRole("button", {
      name: /Start Listening: The keyboard shortcut/,
    });
    fireEvent.mouseEnter(startListeningInfo.parentElement!);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "The keyboard shortcut to start or stop listening.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Models" }));
    expect(
      await screen.findByRole("button", {
        name: /Codex: Codex CLI .* Authenticated/,
      }),
    ).toBeEnabled();
    expect(screen.getByText("Reasoning Models")).toBeVisible();
    expect(screen.queryByText("Client Context")).not.toBeInTheDocument();
    const claudeProvider = screen.getByRole("button", {
      name: /Claude: Claude Code .* Authenticated/,
    });
    expect(claudeProvider).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Transcription Provider" }),
    ).toHaveTextContent("Deepgram");
    expect(
      screen.getByRole("button", { name: "Transcription Model" }),
    ).toHaveTextContent("Nova-3");
    fireEvent.click(
      screen.getByRole("button", { name: "Conversation Language" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "Catalan" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Conversation Language" }),
      ).toHaveTextContent("Catalan"),
    );
    expect(screen.getByLabelText("Deepgram API key")).toHaveAttribute(
      "type",
      "password",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Transcription Provider" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "AssemblyAI" }));
    expect(
      await screen.findByRole("button", { name: "Transcription Model" }),
    ).toHaveTextContent("Universal-3 Pro Streaming");
    expect(
      screen.getByRole("button", { name: "Conversation Language" }),
    ).toHaveTextContent("Auto Detect");
    fireEvent.click(
      screen.getByRole("button", { name: "Conversation Language" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "Spanish" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Conversation Language" }),
      ).toHaveTextContent("Spanish"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Conversation language" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search languages" }),
      {
        target: { value: "Catalan" },
      },
    );
    fireEvent.click(screen.getByRole("option", { name: "Catalan" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Conversation language" }),
      ).toHaveTextContent("Catalan"),
    );
    expect(
      screen.getByRole("button", {
        name: /Conversation language: .*via Deepgram Nova-3/,
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Models" }));
    expect(
      await screen.findByRole("button", { name: "Transcription Provider" }),
    ).toHaveTextContent("Deepgram");
    expect(
      screen.getAllByRole("button", { name: "Reasoning model" })[0],
    ).toHaveTextContent("GPT-5.6 Sol");
    expect(
      screen.getByRole("button", { name: "Service Tier" }),
    ).toHaveTextContent("Standard");
    fireEvent.click(
      screen.getByRole("button", {
        name: /Claude: Claude Code .* Authenticated/,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reasoning Model" }),
      ).toHaveTextContent("Claude Sonnet 5"),
    );
    expect(
      screen.getByRole("button", { name: "Context Window" }),
    ).toHaveTextContent("200k");
    expect(screen.queryByText("Brief Sources")).not.toBeInTheDocument();
    expect(screen.queryByText("Guidance Library")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    expect(screen.queryByText("Use existing brief")).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Open in editor" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Check readiness" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect((await screen.findAllByText(/Version 4/)).length).toBeGreaterThan(0);
    expect(screen.getByText("CONTEXT")).toBeVisible();
    fireEvent.click(screen.getByText("Meeting options"));
    expect(screen.getByText("BRIEF AND LANGUAGE")).toBeVisible();
    const customize = screen.getByRole("button", { name: /Brief prompt/ });
    fireEvent.click(customize);
    expect(customize).toHaveAttribute("aria-controls", "brief-prompt-panel");
    expect(customize).toHaveAttribute("aria-expanded", "true");
    const prompt = screen.getByLabelText("Generation prompt");
    expect(prompt.closest(".prepare-card-body")).toHaveAttribute(
      "id",
      "brief-prompt-panel",
    );
    expect((prompt as HTMLTextAreaElement).value).toContain("source-grounded");
    fireEvent.change(prompt, { target: { value: "Focus on delivery risk." } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(
      (await screen.findAllByText(/savvy-brief-v4.md/)).length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(await screen.findByText("Start Hidden")).toBeVisible();
    expect(screen.getByText("Show Tray Icon")).toBeVisible();
    expect(screen.getByRole("button", { name: "Overlay" })).toHaveTextContent(
      "Live",
    );
    expect(screen.getByText("Show Live Transcript")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "About" }));
    expect(
      await screen.findByRole("button", { name: "Application Theme" }),
    ).toHaveTextContent("System");
    expect(screen.getByText("App Data Directory")).toBeVisible();
    expect(screen.getByText("Log Directory")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(2);
    expect(screen.getAllByText(`v${version}`)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(
      await screen.findByRole("button", { name: "Up to date" }),
    ).toHaveAttribute("aria-disabled", "true");
  }, 15_000);
});
