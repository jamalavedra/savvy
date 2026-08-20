import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  AppPaths,
  AppSettings,
  AppStatus,
  AudioDevice,
  ClientWorkspace,
  DashboardSnapshot,
  MeetingHistoryItem,
  MeetingSession,
  NegotiationBrief,
  PreparationSnapshot,
  ProviderHealth,
  TranscriptUpdate,
  TranscriptionKeyStatus,
  ClientDocument,
} from "../types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const demoClient: ClientWorkspace = {
  id: "demo-client",
  name: "Northstar Health",
  folderPath: "/Clients/Northstar Health",
  indexStatus: "ready",
  documentCount: 24,
  lastIndexedAt: new Date().toISOString(),
  activeBriefId: "demo-brief",
  excludedPaths: [],
};

const demoDocuments: ClientDocument[] = [
  {
    relativePath: "Commercial/Renewal strategy.md",
    kind: "markdown",
    included: true,
  },
  {
    relativePath: "Contracts/msa-2024-signed.pdf",
    kind: "pdf",
    included: true,
  },
  { relativePath: "Finance/q2-usage-export.csv", kind: "csv", included: true },
  { relativePath: "Notes/call-notes-may.md", kind: "markdown", included: true },
  { relativePath: "Design/roadmap.sketch", kind: null, included: false },
];
const demoExcludedPaths = new Map<string, string[]>();

const demoBrief: NegotiationBrief = {
  id: "demo-brief",
  clientId: demoClient.id,
  version: 3,
  status: "approved",
  title: "Enterprise renewal",
  objective:
    "Secure a two-year renewal while protecting implementation capacity and price integrity.",
  responseLanguage: "English",
  ourPosition:
    "The current scope and service level support the proposed renewal price.",
  clientPosition:
    "They want a lower first-year price and a compressed rollout.",
  priorities: [
    "Protect annual contract value",
    "Keep onboarding above eight weeks",
    "Earn a two-year term",
  ],
  agenda: [
    {
      id: "agenda-1",
      title: "Shared outcomes",
      objective: "Confirm what a successful renewal looks like for both teams.",
      talkingPoints: ["Adoption", "Operational impact"],
      keywords: ["outcomes", "success"],
      order: 1,
    },
    {
      id: "agenda-2",
      title: "Commercial structure",
      objective: "Trade term length for pricing flexibility, not margin alone.",
      talkingPoints: ["Two-year term", "Payment timing"],
      keywords: ["price", "discount", "term"],
      order: 2,
    },
    {
      id: "agenda-3",
      title: "Implementation plan",
      objective:
        "Keep the launch credible by protecting the minimum onboarding window.",
      talkingPoints: ["Dependencies", "Eight-week floor"],
      keywords: ["launch", "timeline"],
      order: 3,
    },
  ],
  desiredOutcomes: [
    "Two-year renewal",
    "Price floor maintained",
    "Named executive sponsor",
  ],
  questionsToAsk: [
    "Which budget constraint is driving the requested reduction?",
  ],
  redLines: [
    "No discount without additional term or reduced scope",
    "No launch commitment below eight weeks",
  ],
  prohibitedClaims: ["Do not claim the migration is zero-risk"],
  unauthorizedCommitments: ["Custom integrations", "Service credits"],
  risks: ["Procurement may introduce a competing quote late in the process"],
  customInstructions:
    "Stay warm and direct. Ask one question before responding to each concession request.",
  documentPath:
    "/Application Support/Savvy/briefs/northstar-health/savvy-brief-v3.md",
  documentContent:
    "# Enterprise renewal\n\nProtect price integrity while reaching a two-year renewal.",
  createdAt: new Date().toISOString(),
  approvedAt: new Date().toISOString(),
};

// Browser-demo removals, so `pnpm dev` reflects remove actions instead of no-opping.
const removedDemoClientIds = new Set<string>();
const removedDemoBriefScopes = new Set<string>();

// Demo default is "already onboarded" so the flow does not front every screen in
// `pnpm dev`; tests that exercise onboarding opt in explicitly.
let demoOnboardingCompleted = true;

/** Clears browser-demo state. It is module-level and would otherwise leak between
 * tests that render the app more than once. */
export function resetBrowserDemoState({
  onboardingCompleted = true,
}: { onboardingCompleted?: boolean } = {}): void {
  removedDemoClientIds.clear();
  removedDemoBriefScopes.clear();
  demoExcludedPaths.clear();
  demoOnboardingCompleted = onboardingCompleted;
}

const browserDemo: DashboardSnapshot = {
  clients: [demoClient],
  activeBrief: demoBrief,
  activeSession: null,
  latestRecommendation: {
    id: "demo-recommendation",
    sessionId: "demo-session",
    trigger: "objection",
    say: "If first-year budget is the constraint, we can explore payment timing while keeping the two-year value intact. Which part of the structure creates the most pressure?",
    avoid: "Do not offer a standalone percentage discount.",
    rationale:
      "The approved plan trades commercial flexibility for term, not margin.",
    grounding: "mixed",
    groundingScore: 0.87,
    language: "English",
    sources: [
      {
        kind: "client",
        documentId: "demo-document",
        chunkId: "demo-chunk",
        relativePath: "Commercial/Renewal strategy.md",
        locator: { label: "Concession ladder" },
        excerpt:
          "Payment timing may move after a two-year commitment is confirmed.",
      },
    ],
    sourceTurnIds: [],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    generationId: 1,
    transcriptRevision: 1,
    contextPackHash: "demo-context",
    provider: "codex",
    model: "default",
    lifecycle: "completed",
  },
};

const browserSettings: AppSettings = {
  startListeningShortcut: "Command+Shift+M",
  selectedMicrophone: null,
  selectedChannel: null,
  audioFeedback: false,
  selectedOutputDevice: null,
  audioFeedbackVolume: 0.5,
  recommendationProvider: "codex",
  codexModel: "gpt-5.6-sol",
  codexServiceTier: "default",
  claudeModel: "claude-sonnet-5",
  claudeContextWindow: "200k",
  guidanceFolder: "/Guidance",
  briefGenerationPrompt:
    "Create a concise, source-grounded meeting brief. Apply the reusable guidance to the client evidence. Identify objectives, positions, priorities, a practical discussion outline, desired outcomes, questions, factual talking points with citations, concessions, red lines, prohibited claims, unauthorized commitments, and risks. Never invent client facts. Prefer concrete language that can guide a live conversation.",
  transcriptionProvider: "deepgram",
  transcriptionModel: "nova-3",
  transcriptionLanguage: "multi",
  startHidden: false,
  launchOnStartup: false,
  showTrayIcon: true,
  overlayStyle: "live",
  overlayPosition: "bottom",
  showLiveTranscript: false,
  theme: "system",
  onboardingCompleted: true,
};

export async function getAppStatus(): Promise<AppStatus> {
  if (!window.__TAURI_INTERNALS__) {
    return {
      version: "0.1.0",
      platform: "browser",
    };
  }
  return invoke<AppStatus>("get_app_status");
}

export async function getAppSettings(): Promise<AppSettings> {
  if (!window.__TAURI_INTERNALS__) {
    return { ...browserSettings, onboardingCompleted: demoOnboardingCompleted };
  }
  return invoke<AppSettings>("get_app_settings");
}

export async function getRecommendationProviderStatus(): Promise<
  ProviderHealth[]
> {
  if (!window.__TAURI_INTERNALS__) {
    return [
      {
        provider: "codex",
        available: true,
        credentialPresent: true,
        message: "Codex CLI 0.146.0 · Authenticated",
      },
      {
        provider: "claude",
        available: true,
        credentialPresent: true,
        message: "Claude Code 2.1.224 · Authenticated",
      },
    ];
  }
  return invoke<ProviderHealth[]>("get_recommendation_provider_status");
}

export async function getAppPaths(): Promise<AppPaths> {
  if (!window.__TAURI_INTERNALS__) {
    return {
      appDataDirectory: "/Users/you/Library/Application Support/Savvy",
      logDirectory: "/Users/you/Library/Application Support/Savvy/logs",
    };
  }
  return invoke<AppPaths>("get_app_paths");
}

export async function revealPath(path: string): Promise<void> {
  if (!window.__TAURI_INTERNALS__) return;
  await revealItemInDir(path);
}

export async function updateAppSettings(
  settings: AppSettings,
): Promise<AppSettings> {
  if (!window.__TAURI_INTERNALS__) {
    // Remember completion so finishing onboarding sticks in `pnpm dev`.
    demoOnboardingCompleted = settings.onboardingCompleted;
    return settings;
  }
  return invoke<AppSettings>("update_app_settings", { settings });
}

export async function getTranscriptionKeyStatus(): Promise<TranscriptionKeyStatus> {
  if (!window.__TAURI_INTERNALS__) {
    return { deepgram: false, assemblyAi: false };
  }
  return invoke<TranscriptionKeyStatus>("get_transcription_key_status");
}

export async function setTranscriptionApiKey(
  provider: AppSettings["transcriptionProvider"],
  apiKey: string,
): Promise<TranscriptionKeyStatus> {
  if (!window.__TAURI_INTERNALS__) {
    return {
      deepgram: provider === "deepgram",
      assemblyAi: provider === "assemblyAi",
    };
  }
  return invoke<TranscriptionKeyStatus>("set_transcription_api_key", {
    provider,
    apiKey,
  });
}

export async function deleteTranscriptionApiKey(
  provider: AppSettings["transcriptionProvider"],
): Promise<TranscriptionKeyStatus> {
  if (!window.__TAURI_INTERNALS__) {
    return { deepgram: false, assemblyAi: false };
  }
  return invoke<TranscriptionKeyStatus>("delete_transcription_api_key", {
    provider,
  });
}

export async function getInputDevices(): Promise<AudioDevice[]> {
  if (!window.__TAURI_INTERNALS__) {
    return [{ name: "System default", isDefault: true, channels: 1 }];
  }
  return invoke<AudioDevice[]>("get_input_devices");
}

export async function getOutputDevices(): Promise<AudioDevice[]> {
  if (!window.__TAURI_INTERNALS__) {
    return [{ name: "System default", isDefault: true, channels: 2 }];
  }
  return invoke<AudioDevice[]>("get_output_devices");
}

/** Resolves to true when an update was found (the app then offers to install it). */
export async function checkForUpdates(): Promise<boolean> {
  if (!window.__TAURI_INTERNALS__) return false;
  return invoke<boolean>("check_for_updates");
}

export async function setShortcutRecording(active: boolean): Promise<void> {
  if (!window.__TAURI_INTERNALS__) return;
  return invoke("set_shortcut_recording", { active });
}

export async function getDashboard(): Promise<DashboardSnapshot> {
  if (!window.__TAURI_INTERNALS__) {
    const clients = browserDemo.clients.filter(
      (client) => !removedDemoClientIds.has(client.id),
    );
    const briefRemoved =
      !browserDemo.activeBrief ||
      removedDemoBriefScopes.has(browserDemo.activeBrief.clientId ?? "") ||
      (browserDemo.activeBrief.clientId !== null &&
        removedDemoClientIds.has(browserDemo.activeBrief.clientId));
    return {
      ...browserDemo,
      clients,
      activeBrief: briefRemoved ? null : browserDemo.activeBrief,
    };
  }
  return invoke<DashboardSnapshot>("get_dashboard");
}

export async function getPreparationSnapshot(
  clientId: string | null,
): Promise<PreparationSnapshot> {
  if (!window.__TAURI_INTERNALS__) {
    return {
      guidelines: {
        indexStatus: "ready",
        documentCount: 8,
        checkedAt: new Date().toISOString(),
      },
      client:
        clientId === demoClient.id && !removedDemoClientIds.has(demoClient.id)
          ? demoClient
          : null,
      brief:
        clientId === demoClient.id &&
        !removedDemoClientIds.has(demoClient.id) &&
        !removedDemoBriefScopes.has(clientId ?? "")
          ? demoBrief
          : null,
    };
  }
  return invoke<PreparationSnapshot>("get_preparation_snapshot", { clientId });
}

export async function getMeetingHistory(): Promise<MeetingHistoryItem[]> {
  if (!window.__TAURI_INTERNALS__) {
    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - 18 * 60_000);
    return [
      {
        session: {
          id: "demo-session",
          clientId: demoClient.id,
          briefId: demoBrief.id,
          state: "completed",
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          audioPath: "/recordings/demo.wav",
          contextPackHash: "demo-context",
          sourceIndexRevision: "demo-sources",
        },
        clientName: demoClient.name,
        recommendations: [browserDemo.latestRecommendation!],
      },
    ];
  }
  return invoke<MeetingHistoryItem[]>("get_meeting_history");
}

export async function openRecordingsFolder(): Promise<void> {
  if (!window.__TAURI_INTERNALS__) return;
  await invoke("open_recordings_folder");
}

export async function openMeetingTranscript(sessionId: string): Promise<void> {
  if (!window.__TAURI_INTERNALS__) return;
  await invoke("open_meeting_transcript", { sessionId });
}

export async function deleteMeeting(sessionId: string): Promise<void> {
  if (!window.__TAURI_INTERNALS__) return;
  await invoke("delete_meeting", { sessionId });
}

export async function chooseClientFolder(): Promise<ClientWorkspace | null> {
  if (!window.__TAURI_INTERNALS__) return demoClient;
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Choose a client dossier",
  });
  if (typeof selected !== "string") return null;
  return invoke<ClientWorkspace>("add_client_folder", { path: selected });
}

export async function listClientDocuments(
  clientId: string,
): Promise<ClientDocument[]> {
  if (!window.__TAURI_INTERNALS__) {
    const excluded = new Set(demoExcludedPaths.get(clientId) ?? []);
    return demoDocuments.map((document) => ({
      ...document,
      included: document.kind !== null && !excluded.has(document.relativePath),
    }));
  }
  return invoke<ClientDocument[]>("list_client_documents", { clientId });
}

export async function setClientDocumentSelection(
  clientId: string,
  excludedPaths: string[],
): Promise<ClientWorkspace> {
  if (!window.__TAURI_INTERNALS__) {
    demoExcludedPaths.set(clientId, excludedPaths);
    return { ...demoClient, id: clientId, excludedPaths };
  }
  return invoke<ClientWorkspace>("set_client_document_selection", {
    clientId,
    excludedPaths,
  });
}

export async function removeClientContext(clientId: string): Promise<void> {
  if (!window.__TAURI_INTERNALS__) {
    // Mutate the browser fixtures too, otherwise removal silently does nothing in
    // `pnpm dev` and reads as a broken feature.
    removedDemoClientIds.add(clientId);
    return;
  }
  return invoke("remove_client_context", { clientId });
}

/** Forgets every brief for a scope. `clientId` is null for the general scope. */
export async function removeBrief(clientId: string | null): Promise<void> {
  if (!window.__TAURI_INTERNALS__) {
    removedDemoBriefScopes.add(clientId ?? "");
    return;
  }
  return invoke("remove_brief", { clientId });
}

export async function chooseGuidanceFolder(): Promise<string | null> {
  if (!window.__TAURI_INTERNALS__) return "/Guidance";
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Choose a reusable guidance library",
  });
  return typeof selected === "string" ? selected : null;
}

export async function generateBriefDraft(
  clientId: string | null,
  instructions: string,
): Promise<NegotiationBrief> {
  if (!window.__TAURI_INTERNALS__) {
    return {
      ...demoBrief,
      id: "demo-draft",
      clientId,
      version: demoBrief.version + 1,
      status: "draft",
      customInstructions: instructions,
      documentPath: clientId
        ? `/Application Support/Savvy/briefs/northstar-health/savvy-brief-v${demoBrief.version + 1}.md`
        : `/Application Support/Savvy/briefs/general/savvy-brief-v${demoBrief.version + 1}.md`,
      approvedAt: null,
    };
  }
  return invoke<NegotiationBrief>("generate_brief_draft", {
    clientId,
    instructions,
  });
}

export async function refreshBriefFromDocument(
  briefId: string,
): Promise<NegotiationBrief> {
  if (!window.__TAURI_INTERNALS__) {
    return {
      ...demoBrief,
      id: `${briefId}-refreshed`,
      version: demoBrief.version + 1,
      status: "draft",
      documentPath: `/Application Support/Savvy/briefs/northstar-health/savvy-brief-v${demoBrief.version + 1}.md`,
      approvedAt: null,
    };
  }
  return invoke<NegotiationBrief>("refresh_brief_from_document", {
    briefId,
    path: null,
  });
}

export async function importBriefDocument(
  clientId: string | null,
): Promise<NegotiationBrief | null> {
  if (!window.__TAURI_INTERNALS__) {
    return {
      ...demoBrief,
      id: "demo-imported",
      clientId,
      version: demoBrief.version + 1,
      status: "draft",
      documentPath: "/Clients/Northstar Health/selected-brief.md",
      approvedAt: null,
    };
  }
  const selected = await open({
    multiple: false,
    title: "Choose a brief document",
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (typeof selected !== "string") return null;
  return invoke<NegotiationBrief>("import_brief_document", {
    clientId,
    path: selected,
  });
}

export async function replaceBriefDocument(
  briefId: string,
): Promise<NegotiationBrief | null> {
  if (!window.__TAURI_INTERNALS__) {
    return {
      ...demoBrief,
      id: `${briefId}-selected`,
      version: demoBrief.version + 1,
      status: "draft",
      documentPath: "/Clients/Northstar Health/selected-brief.md",
      approvedAt: null,
    };
  }
  const selected = await open({
    multiple: false,
    title: "Choose a brief document",
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (typeof selected !== "string") return null;
  return invoke<NegotiationBrief>("refresh_brief_from_document", {
    briefId,
    path: selected,
  });
}

export async function openBriefDocument(briefId: string): Promise<void> {
  if (!window.__TAURI_INTERNALS__) return;
  return invoke("open_brief_document", { briefId });
}

export async function startMeeting(
  clientId: string | null,
  briefId: string | null,
): Promise<MeetingSession> {
  if (!window.__TAURI_INTERNALS__) {
    return {
      id: crypto.randomUUID(),
      clientId,
      briefId,
      state: "recording",
      startedAt: new Date().toISOString(),
      endedAt: null,
      audioPath: null,
      contextPackHash: "demo-context",
      sourceIndexRevision: "demo-sources",
    };
  }
  return invoke<MeetingSession>("start_meeting", { clientId, briefId });
}

export async function getAudioLevel(): Promise<number> {
  if (!window.__TAURI_INTERNALS__) return 0;
  return invoke<number>("get_audio_level");
}

export async function pauseMeeting(sessionId: string): Promise<MeetingSession> {
  if (!window.__TAURI_INTERNALS__) {
    return { ...browserDemo.activeSession!, id: sessionId, state: "paused" };
  }
  return invoke<MeetingSession>("pause_meeting", { sessionId });
}

export async function resumeMeeting(
  sessionId: string,
): Promise<MeetingSession> {
  if (!window.__TAURI_INTERNALS__) {
    return { ...browserDemo.activeSession!, id: sessionId, state: "recording" };
  }
  return invoke<MeetingSession>("resume_meeting", { sessionId });
}

export async function requestRecommendation(sessionId: string): Promise<void> {
  if (!window.__TAURI_INTERNALS__) {
    return;
  }
  return invoke<void>("request_recommendation", { sessionId });
}

export async function appendTranscriptTurn(
  sessionId: string,
  text: string,
  startMs: number,
  endMs: number,
): Promise<TranscriptUpdate> {
  if (!window.__TAURI_INTERNALS__) {
    return {
      turn: {
        id: crypto.randomUUID(),
        sessionId,
        channel: "other",
        text,
        language: "en",
        startMs,
        endMs,
        isFinal: true,
        confidence: 0.92,
      },
      recommendation: {
        ...browserDemo.latestRecommendation!,
        id: crypto.randomUUID(),
        trigger: text.includes("?") ? "question" : "objection",
      },
    };
  }
  return invoke<TranscriptUpdate>("append_transcript_turn", {
    input: {
      sessionId,
      channel: "other",
      text,
      startMs,
      endMs,
      isFinal: true,
    },
  });
}

export async function stopMeeting(sessionId: string): Promise<MeetingSession> {
  if (!window.__TAURI_INTERNALS__) {
    return {
      id: sessionId,
      clientId: demoClient.id,
      briefId: demoBrief.id,
      state: "completed",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      audioPath: null,
      contextPackHash: "demo-context",
      sourceIndexRevision: "demo-sources",
    };
  }
  return invoke<MeetingSession>("stop_meeting", { sessionId });
}
