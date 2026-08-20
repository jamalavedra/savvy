import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App, { MeetingOverlay } from "./App";
import {
  meetingEventIsStale,
  mergeTranscriptTurn,
  startsNewMeeting,
} from "./lib/meetingEvents";
import { resetBrowserDemoState } from "./lib/api";
import { requestPermissionDecision } from "./lib/permissions";
import type { TranscriptTurn } from "./types";

describe("App", () => {
  beforeEach(() => resetBrowserDemoState());

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
      screen.getByRole("button", { name: "Meeting language" }),
    ).toHaveTextContent("Auto Detect");
    expect(
      screen.queryByRole("button", { name: /Manage sources/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Open client folder/ }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Remove client/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /General guidelines/ }));
    expect(screen.getByText("Guidance Library")).toBeVisible();
    expect(
      screen.getByText("Reusable guidance used across meetings"),
    ).toBeVisible();
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
    fireEvent.click(screen.getByRole("button", { name: "Start listening" }));
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

  it("disables Advice while an automatic recommendation is thinking", () => {
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
        thinking
      />,
    );

    expect(screen.getByText("Savvy is thinking")).toBeVisible();
    expect(document.querySelector(".mascot-state.thinking")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Get recommendation now" }),
    ).toBeDisabled();
    expect(screen.getByText("Thinking…")).toBeVisible();
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
    fireEvent.click(screen.getByRole("button", { name: "Start listening" }));
    expect(await screen.findByText("Savvy is listening")).toBeVisible();
  });

  it("removes a recommendation when its Keep countdown completes", async () => {
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

    // Off macOS there is nothing to grant, so the step is already satisfied.
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("button", { name: "Skip for now" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

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
        await screen.findByRole("button", { name: "More brief actions" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Remove brief" }));

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
    fireEvent.click(
      screen.getByRole("button", { name: "Change start listening shortcut" }),
    );
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
    fireEvent.click(screen.getByRole("button", { name: "Meeting language" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search languages" }),
      {
        target: { value: "Catalan" },
      },
    );
    fireEvent.click(screen.getByRole("option", { name: "Catalan" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Meeting language" }),
      ).toHaveTextContent("Catalan"),
    );
    expect(screen.getByText(/via Deepgram Nova-3/)).toBeVisible();
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
      screen.getByRole("button", { name: "Start listening" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect((await screen.findAllByText(/Version 4/)).length).toBeGreaterThan(0);
    const customize = screen.getByRole("button", {
      name: /Customize generation/,
    });
    fireEvent.click(customize);
    expect(customize).toHaveAttribute(
      "aria-controls",
      "customize-generation-panel",
    );
    expect(customize).toHaveAttribute("aria-expanded", "true");
    const prompt = screen.getByLabelText("Generation prompt");
    expect(prompt.closest(".prepare-disclosure-panel")).toHaveAttribute(
      "id",
      "customize-generation-panel",
    );
    expect((prompt as HTMLTextAreaElement).value).toContain("source-grounded");
    fireEvent.change(prompt, { target: { value: "Focus on delivery risk." } });
    fireEvent.click(screen.getByRole("button", { name: "More brief actions" }));
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
    expect(screen.getAllByText("v0.1.0")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Check for updates" }),
    ).toBeVisible();
  }, 15_000);
});
