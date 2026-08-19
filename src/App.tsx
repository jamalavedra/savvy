import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type SVGProps,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronDown,
  Check,
  Cpu,
  FileText,
  FolderOpen,
  Hand,
  History,
  Info,
  Mic,
  MicOff,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  Settings,
  Sparkles,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import "./App.css";
import mascotListening from "./assets/mascot-states/savvy-listening-upload.png";
import mascotMuted from "./assets/mascot-states/savvy-muted-upload.png";
import mascotThinking from "./assets/mascot-states/savvy-thinking.png";
import {
  checkForUpdates,
  chooseClientFolder,
  chooseGuidanceFolder,
  deleteTranscriptionApiKey,
  deleteMeeting,
  generateBriefDraft,
  getAppPaths,
  getAppSettings,
  getAppStatus,
  getAudioLevel,
  getDashboard,
  getInputDevices,
  getMeetingHistory,
  getPreparationSnapshot,
  getOutputDevices,
  getRecommendationProviderStatus,
  getTranscriptionKeyStatus,
  openMeetingTranscript,
  openBriefDocument,
  openRecordingsFolder,
  pauseMeeting,
  requestRecommendation,
  revealPath,
  refreshBriefFromDocument,
  importBriefDocument,
  replaceBriefDocument,
  removeBrief,
  removeClientContext,
  resumeMeeting,
  setTranscriptionApiKey,
  setShortcutRecording,
  startMeeting,
  stopMeeting,
  updateAppSettings,
} from "./lib/api";
import Onboarding from "./Onboarding";
import { requestPermissionDecision } from "./lib/permissions";
import {
  meetingEventIsStale,
  mergeTranscriptTurn,
  startsNewMeeting,
} from "./lib/meetingEvents";
import type {
  AppPaths,
  AppSettings,
  AudioDevice,
  ClientWorkspace,
  DashboardSnapshot,
  MeetingEvent,
  MeetingSession,
  MeetingHistoryItem,
  NegotiationBrief,
  PreparationSnapshot,
  ProviderHealth,
  Recommendation,
  RecommendationTrigger,
  TranscriptTurn,
  TranscriptionKeyStatus,
} from "./types";

type View =
  "prepare" | "general" | "models" | "advanced" | "meetings" | "about";

const MIN_RECOMMENDATION_DISPLAY_MS = 15_000;
const MAX_RECOMMENDATION_DISPLAY_MS = 30_000;

const icons = {
  prepare: Sparkles,
  general: Hand,
  models: Cpu,
  advanced: Settings,
  meetings: History,
  about: Info,
};

function OpenAILogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 256 260" fill="currentColor">
      <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
    </svg>
  );
}

function ClaudeLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 256 257" fill="currentColor">
      <path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z" />
    </svg>
  );
}

const reasoningProviders = [
  { value: "codex", label: "Codex", icon: OpenAILogo },
  { value: "claude", label: "Claude", icon: ClaudeLogo },
] as const;

function App() {
  const overlayWindow = new URLSearchParams(window.location.search).has(
    "overlay",
  );
  const [view, setView] = useState<View>("prepare");
  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null);
  const [activeClientId, setActiveClientId] = useState<string | null>(null);
  const [loadedPreparation, setPreparation] =
    useState<PreparationSnapshot | null>(null);
  const [preparationRevision, setPreparationRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  // null while the check is in flight, so onboarding never flashes on startup.
  const [onboarding, setOnboarding] = useState<
    "new" | "returning" | "done" | null
  >(null);
  const [version, setVersion] = useState("0.1.0");
  const [transcriptTurns, setTranscriptTurns] = useState<TranscriptTurn[]>([]);
  const [thinking, setThinking] = useState(false);
  const visibleSessionRef = useRef("");
  const generationRef = useRef<{
    sessionId: string;
    generationId: number;
    sequence: number;
    terminalGenerationId: number;
    trigger: RecommendationTrigger | null;
  }>({
    sessionId: "",
    generationId: 0,
    sequence: 0,
    terminalGenerationId: 0,
    trigger: null,
  });
  const handleStartRequest = useEffectEvent(() =>
    dashboard?.activeSession
      ? void endActiveMeeting()
      : void startActiveMeeting(),
  );
  const handleStopRequest = useEffectEvent(() => void endActiveMeeting());
  function applyRecommendation(recommendation: Recommendation) {
    setDashboard((current) =>
      current ? { ...current, latestRecommendation: recommendation } : current,
    );
  }
  const handleMeetingEvent = useEffectEvent((event: MeetingEvent) => {
    const current = generationRef.current;
    if (meetingEventIsStale(event, current)) return;
    if (event.type === "transcript") {
      const sameSession = event.sessionId === current.sessionId;
      generationRef.current = {
        sessionId: event.sessionId,
        generationId: sameSession ? current.generationId : 0,
        sequence: event.sequence,
        terminalGenerationId: sameSession ? current.terminalGenerationId : 0,
        trigger: sameSession ? current.trigger : null,
      };
      if (!sameSession) setThinking(false);
      setTranscriptTurns((turns) => mergeTranscriptTurn(turns, event.turn));
      return;
    }
    if (
      event.type === "recommendationStarted" &&
      (event.sessionId !== current.sessionId ||
        event.generationId >= current.generationId)
    ) {
      generationRef.current = {
        sessionId: event.sessionId,
        generationId: event.generationId,
        sequence: Math.max(current.sequence, event.sequence),
        terminalGenerationId: current.terminalGenerationId,
        trigger: event.trigger,
      };
      setThinking(true);
      if (event.trigger !== "opportunity") {
        setDashboard((dashboard) =>
          dashboard
            ? { ...dashboard, latestRecommendation: event.local }
            : dashboard,
        );
      }
      return;
    }
    if (event.sessionId !== current.sessionId) {
      return;
    }
    generationRef.current = {
      sessionId: event.sessionId,
      generationId: event.generationId,
      sequence: Math.max(current.sequence, event.sequence),
      terminalGenerationId: Math.max(
        current.terminalGenerationId,
        event.generationId,
      ),
      trigger: null,
    };
    setThinking(false);
    if (event.type === "recommendationCompleted")
      applyRecommendation(event.recommendation);
  });

  async function refreshDashboard() {
    try {
      const snapshot = await getDashboard();
      setDashboard(snapshot);
      setActiveClientId((current) =>
        current === null ||
        snapshot.clients.some((client) => client.id === current)
          ? current
          : (snapshot.clients[0]?.id ?? null),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  useEffect(() => {
    Promise.all([getAppStatus(), getAppSettings()])
      .then(async ([status, settings]) => {
        setAppSettings(settings);
        setVersion(status.version);
        document.documentElement.dataset.platform = status.platform;
        if (!settings.onboardingCompleted) {
          setOnboarding("new");
          return;
        }
        // Already onboarded, but a permission can be revoked at any time. Repair it
        // up front rather than failing when a meeting is about to start.
        if (status.platform !== "macos") {
          setOnboarding("done");
          return;
        }
        try {
          const { checkMicrophonePermission, checkScreenRecordingPermission } =
            await import("tauri-plugin-macos-permissions-api");
          const [microphone, capture] = await Promise.all([
            checkMicrophonePermission(),
            checkScreenRecordingPermission(),
          ]);
          setOnboarding(microphone && capture ? "done" : "returning");
        } catch {
          // If the permissions cannot be read, do not block the app.
          setOnboarding("done");
        }
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);

  const clientRevision =
    dashboard?.clients.map((client) => client.id).join(",") ?? null;
  const preparation =
    loadedPreparation &&
    (loadedPreparation.client?.id ?? null) === activeClientId
      ? loadedPreparation
      : null;

  useEffect(() => {
    if (clientRevision === null) return;
    let cancelled = false;
    getPreparationSnapshot(activeClientId)
      .then((snapshot) => {
        if (!cancelled) setPreparation(snapshot);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeClientId, clientRevision, preparationRevision]);

  useEffect(() => {
    getDashboard()
      .then((snapshot) => {
        setDashboard(snapshot);
        setActiveClientId(snapshot.clients[0]?.id ?? null);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    if (overlayWindow) return;
    const refresh = () => void refreshDashboard();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [overlayWindow]);

  useEffect(() => {
    document.documentElement.dataset.surface = overlayWindow
      ? "overlay"
      : "main";
  }, [overlayWindow]);

  useEffect(() => {
    document.documentElement.dataset.theme = appSettings?.theme ?? "system";
  }, [appSettings?.theme]);

  useEffect(() => {
    if (overlayWindow || window.__TAURI_INTERNALS__) return;
    const onShortcut = (event: KeyboardEvent) => {
      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        handleStartRequest();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [overlayWindow]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let cancelled = false;
    let unlisten: Array<() => void> = [];
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        Promise.all([
          listen<MeetingEvent>("meeting://event", (event) =>
            handleMeetingEvent(event.payload),
          ),
          listen<MeetingSession>("meeting://session", (event) => {
            const newMeeting = startsNewMeeting(
              event.payload,
              visibleSessionRef.current,
            );
            if (newMeeting) {
              visibleSessionRef.current = event.payload.id;
              generationRef.current = {
                sessionId: event.payload.id,
                generationId: 0,
                sequence: 0,
                terminalGenerationId: 0,
                trigger: null,
              };
              setTranscriptTurns([]);
              setThinking(false);
              setError(null);
            }
            setDashboard((current) =>
              current
                ? {
                    ...current,
                    latestRecommendation: newMeeting
                      ? null
                      : current.latestRecommendation,
                    activeSession:
                      event.payload.state === "recording" ||
                      event.payload.state === "paused"
                        ? event.payload
                        : null,
                  }
                : current,
            );
            if (!overlayWindow && event.payload.state === "completed") {
              setThinking(false);
              setView("meetings");
            }
          }),
          listen<string>("meeting://provider-error", (event) =>
            setError(event.payload),
          ),
          ...(overlayWindow
            ? []
            : [
                listen("savvy://start-listening", handleStartRequest),
                listen("savvy://stop-listening", handleStopRequest),
                listen("savvy://open-settings", () => setView("general")),
              ]),
        ]),
      )
      .then((listeners) => {
        if (cancelled) listeners.forEach((listener) => listener());
        else unlisten = listeners;
      });
    return () => {
      cancelled = true;
      unlisten.forEach((listener) => listener());
    };
  }, [overlayWindow]);

  const activeClient = useMemo(
    () =>
      dashboard?.clients.find((client) => client.id === activeClientId) ?? null,
    [activeClientId, dashboard],
  );

  async function saveAppSettings(
    patch: Partial<AppSettings>,
  ): Promise<boolean> {
    if (!appSettings) return false;
    setSettingsBusy(true);
    setError(null);
    try {
      setAppSettings(await updateAppSettings({ ...appSettings, ...patch }));
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setSettingsBusy(false);
    }
  }

  async function addClient() {
    setBusy(true);
    setError(null);
    try {
      const client = await chooseClientFolder();
      if (!client) return;
      setDashboard((current) => ({
        clients: [
          ...(current?.clients.filter((item) => item.id !== client.id) ?? []),
          client,
        ],
        activeBrief: current?.activeBrief ?? null,
        activeSession: current?.activeSession ?? null,
        latestRecommendation: current?.latestRecommendation ?? null,
      }));
      setActiveClientId(client.id);
      setView("prepare");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function removeClient(client: ClientWorkspace) {
    if (
      !window.confirm(
        `Remove ${client.name} from Savvy?\n\nThis removes its local briefs and meeting history. The source folder and its files stay untouched.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await removeClientContext(client.id);
      await refreshDashboard();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function completeOnboarding() {
    setOnboarding("done");
    if (!appSettings || appSettings.onboardingCompleted) return;
    try {
      setAppSettings(
        await updateAppSettings({ ...appSettings, onboardingCompleted: true }),
      );
    } catch (reason) {
      // Setup already happened; failing to record that must not block the app.
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function removeCurrentBrief() {
    if (
      !window.confirm(
        "Remove this brief from Savvy?\n\nThe meeting will run on general guidelines only. The Markdown file stays on disk.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await removeBrief(activeClient?.id ?? null);
      await refreshDashboard();
      setPreparationRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function prepareBrief(
    instructions = appSettings?.briefGenerationPrompt,
  ) {
    if (!instructions) return;
    setBusy(true);
    setError(null);
    try {
      if (
        instructions !== appSettings?.briefGenerationPrompt &&
        !(await saveAppSettings({ briefGenerationPrompt: instructions }))
      ) {
        return;
      }
      const brief = await generateBriefDraft(
        activeClient?.id ?? null,
        instructions,
      );
      setPreparation((current) => (current ? { ...current, brief } : current));
      setDashboard((current) =>
        current ? { ...current, activeBrief: brief } : current,
      );
      setView("prepare");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function refreshCurrentBrief() {
    const brief = preparation?.brief;
    if (!brief) return;
    setBusy(true);
    setError(null);
    try {
      const refreshed = await refreshBriefFromDocument(brief.id);
      setPreparation((current) =>
        current ? { ...current, brief: refreshed } : current,
      );
      setDashboard((current) =>
        current ? { ...current, activeBrief: refreshed } : current,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function importCurrentBrief() {
    setBusy(true);
    setError(null);
    try {
      const selected = await importBriefDocument(activeClient?.id ?? null);
      if (selected) {
        setPreparation((current) =>
          current ? { ...current, brief: selected } : current,
        );
        setDashboard((current) =>
          current ? { ...current, activeBrief: selected } : current,
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function replaceCurrentBrief() {
    const brief = preparation?.brief;
    if (!brief) return;
    setBusy(true);
    setError(null);
    try {
      const selected = await replaceBriefDocument(brief.id);
      if (selected) {
        setPreparation((current) =>
          current ? { ...current, brief: selected } : current,
        );
        setDashboard((current) =>
          current ? { ...current, activeBrief: selected } : current,
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function startActiveMeeting() {
    if (dashboard?.activeSession) {
      return;
    }
    const brief =
      preparation?.brief?.clientId === (activeClient?.id ?? null)
        ? preparation.brief
        : null;
    setBusy(true);
    setError(null);
    try {
      if (window.__TAURI_INTERNALS__ && appSettings) {
        const keyStatus = await getTranscriptionKeyStatus();
        if (!keyStatus[appSettings.transcriptionProvider]) {
          const provider =
            appSettings.transcriptionProvider === "deepgram"
              ? "Deepgram"
              : "AssemblyAI";
          throw new Error(
            `Add a ${provider} API key in Models before starting.`,
          );
        }
        if ((await getAppStatus()).platform === "macos") {
          const {
            checkMicrophonePermission,
            checkScreenRecordingPermission,
            requestMicrophonePermission,
            requestScreenRecordingPermission,
          } = await import("tauri-plugin-macos-permissions-api");
          if (!(await checkMicrophonePermission())) {
            const allowed = await requestPermissionDecision(
              requestMicrophonePermission,
              checkMicrophonePermission,
            );
            if (!allowed) {
              throw new Error(
                "Allow Savvy microphone access in System Settings, then press Start listening again.",
              );
            }
          }
          if (!(await checkScreenRecordingPermission())) {
            await requestPermissionDecision(
              requestScreenRecordingPermission,
              checkScreenRecordingPermission,
            );
          }
        }
      }
      const meetingBrief = brief;
      const session = await startMeeting(
        activeClient?.id ?? null,
        meetingBrief?.id ?? null,
      );
      setTranscriptTurns([]);
      if (meetingBrief) {
        setPreparation((current) =>
          current ? { ...current, brief: meetingBrief } : current,
        );
      }
      setDashboard((current) =>
        current
          ? {
              ...current,
              activeBrief: meetingBrief ?? current.activeBrief,
              activeSession: session,
              latestRecommendation: null,
            }
          : current,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function endActiveMeeting() {
    const session = dashboard?.activeSession;
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await stopMeeting(session.id);
      setView("meetings");
      setDashboard((current) =>
        current
          ? { ...current, activeSession: null, latestRecommendation: null }
          : current,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function toggleMeetingPause() {
    const session = dashboard?.activeSession;
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const updated =
        session.state === "paused"
          ? await resumeMeeting(session.id)
          : await pauseMeeting(session.id);
      if (updated.state === "paused") setThinking(false);
      setDashboard((current) =>
        current ? { ...current, activeSession: updated } : current,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function forceRecommendation() {
    const session = dashboard?.activeSession;
    if (!session) return;
    generationRef.current = { ...generationRef.current, trigger: "manual" };
    setThinking(true);
    setError(null);
    setDashboard((current) =>
      current ? { ...current, latestRecommendation: null } : current,
    );
    try {
      await requestRecommendation(session.id);
    } catch (reason) {
      generationRef.current = { ...generationRef.current, trigger: null };
      setThinking(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  if (!dashboard) return <LoadingState />;

  // The overlay window is a separate surface and must never be fronted by setup.
  if (
    !overlayWindow &&
    (onboarding === "new" || onboarding === "returning") &&
    appSettings
  ) {
    return (
      <Onboarding
        returningUser={onboarding === "returning"}
        onComplete={() => void completeOnboarding()}
      />
    );
  }

  if (
    overlayWindow ||
    (!window.__TAURI_INTERNALS__ && dashboard.activeSession)
  ) {
    return (
      <MeetingOverlay
        session={dashboard.activeSession}
        turns={transcriptTurns}
        recommendation={dashboard.latestRecommendation}
        onTogglePause={toggleMeetingPause}
        onRequestRecommendation={forceRecommendation}
        onStop={endActiveMeeting}
        busy={busy}
        error={error}
        style={appSettings?.overlayStyle ?? "live"}
        position={appSettings?.overlayPosition ?? "bottom"}
        showTranscript={appSettings?.showLiveTranscript ?? false}
        thinking={thinking}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark" aria-label="Savvy">
          <strong className="savvy-wordmark">savvy</strong>
        </div>
        <nav aria-label="Primary navigation">
          <NavButton
            active={view === "prepare"}
            icon={icons.prepare}
            label="Prepare"
            onClick={() => setView("prepare")}
          />
          <span className="nav-divider" />
          <NavButton
            active={view === "general"}
            icon={icons.general}
            label="General"
            onClick={() => setView("general")}
          />
          <NavButton
            active={view === "models"}
            icon={icons.models}
            label="Models"
            onClick={() => setView("models")}
          />
          <NavButton
            active={view === "advanced"}
            icon={icons.advanced}
            label="Advanced"
            onClick={() => setView("advanced")}
          />
          <NavButton
            active={view === "meetings"}
            icon={icons.meetings}
            label="History"
            onClick={() => setView("meetings")}
          />
          <NavButton
            active={view === "about"}
            icon={icons.about}
            label="About"
            onClick={() => setView("about")}
          />
        </nav>
      </aside>

      <main className="workspace">
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              type="button"
              aria-label="Dismiss alert"
              title="Dismiss"
              onClick={() => setError(null)}
            >
              <X />
            </button>
          </div>
        )}
        <div className="page-scroll">
          {view === "prepare" ? (
            <PrepareView
              key={`${activeClientId ?? "general"}:${appSettings?.briefGenerationPrompt ?? ""}`}
              dashboard={dashboard}
              activeClient={activeClient}
              preparation={preparation}
              onSelectClient={setActiveClientId}
              onAddClient={addClient}
              onRemoveClient={removeClient}
              generationPrompt={appSettings?.briefGenerationPrompt ?? ""}
              provider={appSettings?.recommendationProvider ?? "codex"}
              transcriptionProvider={
                appSettings?.transcriptionProvider ?? "deepgram"
              }
              transcriptionModel={appSettings?.transcriptionModel ?? "nova-3"}
              transcriptionLanguage={
                appSettings?.transcriptionLanguage ?? "multi"
              }
              onPrepareBrief={prepareBrief}
              onImportBrief={importCurrentBrief}
              onReplaceBrief={replaceCurrentBrief}
              onOpenBrief={(briefId) => void openBriefDocument(briefId)}
              onRefreshBrief={refreshCurrentBrief}
              onRemoveBrief={removeCurrentBrief}
              onStartMeeting={startActiveMeeting}
              busy={busy}
              shortcut={
                appSettings?.startListeningShortcut ?? "Command+Shift+M"
              }
              guidanceFolder={appSettings?.guidanceFolder ?? null}
              settingsBusy={settingsBusy}
              onSaveSettings={async (patch) => {
                const saved = await saveAppSettings(patch);
                if (saved) setPreparationRevision((value) => value + 1);
                return saved;
              }}
            />
          ) : view === "meetings" ? (
            <HistoryView key={dashboard.activeSession?.id ?? "idle"} />
          ) : (
            <SettingsView
              section={view}
              settings={appSettings}
              version={version}
              saving={settingsBusy}
              onSave={saveAppSettings}
            />
          )}
        </div>
      </main>
      <AppFooter
        settings={appSettings}
        version={version}
        saving={settingsBusy}
        onSave={saveAppSettings}
      />
    </div>
  );
}

function NavButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  const Icon = icon;
  return (
    <button
      className={`nav-button ${active ? "active" : ""}`}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
    >
      <span className="nav-icon">
        <Icon width={24} height={24} />
      </span>
      <span>{label}</span>
    </button>
  );
}

function PrepareView({
  dashboard,
  activeClient,
  preparation,
  onSelectClient,
  onAddClient,
  onRemoveClient,
  generationPrompt,
  provider,
  transcriptionProvider,
  transcriptionModel,
  transcriptionLanguage,
  onPrepareBrief,
  onImportBrief,
  onReplaceBrief,
  onOpenBrief,
  onRefreshBrief,
  onRemoveBrief,
  onStartMeeting,
  busy,
  shortcut,
  guidanceFolder,
  settingsBusy,
  onSaveSettings,
}: {
  dashboard: DashboardSnapshot;
  activeClient: ClientWorkspace | null;
  preparation: PreparationSnapshot | null;
  onSelectClient: (id: string | null) => void;
  onAddClient: () => void;
  onRemoveClient: (client: ClientWorkspace) => void;
  generationPrompt: string;
  provider: AppSettings["recommendationProvider"];
  transcriptionProvider: AppSettings["transcriptionProvider"];
  transcriptionModel: string;
  transcriptionLanguage: string;
  onPrepareBrief: (prompt?: string) => void;
  onImportBrief: () => void;
  onReplaceBrief: () => void;
  onOpenBrief: (briefId: string) => void;
  onRefreshBrief: () => void;
  onRemoveBrief: () => void;
  onStartMeeting: () => void;
  busy: boolean;
  shortcut: string;
  guidanceFolder: string | null;
  settingsBusy: boolean;
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<boolean>;
}) {
  const [prompt, setPrompt] = useState(generationPrompt);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [guidelinesOpen, setGuidelinesOpen] = useState(false);
  const brief = preparation?.brief ?? null;
  const providerName = provider === "claude" ? "Claude" : "Codex";
  const selectedTranscriptionModel =
    transcriptionModels[transcriptionProvider].find(
      (model) => model.value === transcriptionModel,
    ) ?? transcriptionModels[transcriptionProvider][0];
  const meetingLanguageOptions = conversationLanguages.filter(
    ({ value }) =>
      value === "multi" ||
      Object.values(transcriptionModels).some((models) =>
        models.some((model) => model.languages.includes(value)),
      ),
  );

  return (
    <div className="page-content prepare-page">
      <div className="page-title prepare-title">
        <div>
          <h1>Prepare for your meeting</h1>
          <p>Choose what Savvy should know before you start listening.</p>
        </div>
        <button
          className="button primary"
          onClick={onStartMeeting}
          disabled={busy || settingsBusy}
          aria-label="Start listening"
        >
          <Mic width={14} height={14} /> Start listening
          <kbd>{formatShortcut(shortcut)}</kbd>
        </button>
      </div>

      <section className="prepare-section">
        <h2 className="group-title">MEETING LANGUAGE</h2>
        <div className="meeting-language-row">
          <span className="setting-copy">
            <strong>Conversation language</strong>
            <small>
              Used for transcripts and recommendations via{" "}
              {transcriptionProviders.find(
                ({ value }) => value === transcriptionProvider,
              )?.label ?? transcriptionProvider}{" "}
              {selectedTranscriptionModel.label}.
            </small>
          </span>
          <Dropdown
            label="Meeting language"
            options={meetingLanguageOptions}
            selectedValue={transcriptionLanguage}
            disabled={busy || settingsBusy}
            searchable
            onSelect={(value) => {
              const currentSupports =
                selectedTranscriptionModel.languages.includes(value);
              if (currentSupports) {
                void onSaveSettings({ transcriptionLanguage: value });
                return;
              }
              const compatible = Object.entries(transcriptionModels)
                .flatMap(([provider, models]) =>
                  models.map((model) => ({ provider, model })),
                )
                .find(({ model }) => model.languages.includes(value));
              if (!compatible) return;
              void onSaveSettings({
                transcriptionProvider:
                  compatible.provider as AppSettings["transcriptionProvider"],
                transcriptionModel: compatible.model.value,
                transcriptionLanguage: value,
              });
            }}
          />
        </div>
      </section>

      <section className="prepare-section">
        <h2 className="group-title">MEETING CONTEXT</h2>
        <MeetingContextSelector
          clients={dashboard.clients}
          selectedClient={activeClient}
          disabled={busy}
          onSelect={onSelectClient}
          onAddClient={onAddClient}
        />
        {activeClient && (
          <div className="client-context-actions">
            <button
              className="button secondary"
              disabled={busy || settingsBusy}
              onClick={() => void revealPath(activeClient.folderPath)}
            >
              <FolderOpen /> Open client folder
            </button>
            <button
              className="button danger"
              disabled={busy || settingsBusy}
              onClick={() => onRemoveClient(activeClient)}
            >
              <Trash2 /> Remove client
            </button>
          </div>
        )}
      </section>

      {brief ? (
        <BriefPreview
          brief={brief}
          busy={busy}
          onOpen={() => onOpenBrief(brief.id)}
          onRefresh={onRefreshBrief}
          onReplace={onReplaceBrief}
          onRegenerate={() => onPrepareBrief(prompt)}
          onRemove={onRemoveBrief}
        />
      ) : (
        <BriefEmptyState
          busy={busy}
          providerName={providerName}
          onGenerate={() => onPrepareBrief(prompt)}
          onImport={onImportBrief}
        />
      )}

      <div className="prepare-accordion">
        <DisclosureButton
          label="Customize generation"
          detail={`Prompt and ${providerName} provider`}
          open={customizeOpen}
          controls="customize-generation-panel"
          onClick={() => setCustomizeOpen((value) => !value)}
        />
        {customizeOpen && (
          <div
            id="customize-generation-panel"
            className="prepare-disclosure-panel"
          >
            <label htmlFor="brief-generation-prompt">Generation prompt</label>
            <textarea
              id="brief-generation-prompt"
              value={prompt}
              disabled={busy}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <small>Uses the active reasoning provider: {providerName}</small>
          </div>
        )}
      </div>

      <div className="prepare-accordion">
        <DisclosureButton
          label="General guidelines"
          detail="Reusable guidance used across meetings"
          open={guidelinesOpen}
          controls="general-guidelines-panel"
          onClick={() => setGuidelinesOpen((value) => !value)}
        />
        {guidelinesOpen && (
          <div
            id="general-guidelines-panel"
            className="prepare-disclosure-panel guidance-management"
          >
            <GuidanceFolderSetting
              path={guidanceFolder}
              disabled={busy || settingsBusy}
              onSave={onSaveSettings}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function MeetingContextSelector({
  clients,
  selectedClient,
  disabled,
  onSelect,
  onAddClient,
}: {
  clients: ClientWorkspace[];
  selectedClient: ClientWorkspace | null;
  disabled: boolean;
  onSelect: (id: string | null) => void;
  onAddClient: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="meeting-context-selector" ref={ref}>
      <button
        type="button"
        className="meeting-context-control"
        disabled={disabled}
        aria-label="Meeting context"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="client-avatar">
          {selectedClient ? initials(selectedClient.name) : <Sparkles />}
        </span>
        <span className="setting-copy">
          <strong>{selectedClient?.name ?? "General guidelines only"}</strong>
          <small>
            {selectedClient
              ? `${selectedClient.documentCount} source documents`
              : "No client folder required"}
          </small>
        </span>
        <ChevronDown />
      </button>
      {open && !disabled && (
        <div
          className="meeting-context-menu"
          role="listbox"
          aria-label="Meeting context"
        >
          <button
            type="button"
            role="option"
            aria-selected={!selectedClient}
            className={!selectedClient ? "selected" : ""}
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
          >
            <span className="client-avatar">
              <Sparkles />
            </span>
            <span className="setting-copy">
              <strong>General guidelines only</strong>
              <small>No client folder required</small>
            </span>
            {!selectedClient && <Check />}
          </button>
          {clients.map((client) => (
            <button
              type="button"
              role="option"
              aria-selected={client.id === selectedClient?.id}
              className={client.id === selectedClient?.id ? "selected" : ""}
              key={client.id}
              onClick={() => {
                onSelect(client.id);
                setOpen(false);
              }}
            >
              <span className="client-avatar">{initials(client.name)}</span>
              <span className="setting-copy">
                <strong>{client.name}</strong>
                <small>{client.documentCount} source documents</small>
              </span>
              {client.id === selectedClient?.id && <Check />}
            </button>
          ))}
          <button
            type="button"
            className="add-context-option"
            onClick={() => {
              setOpen(false);
              onAddClient();
            }}
          >
            <span className="client-avatar">
              <FolderOpen />
            </span>
            <span className="setting-copy">
              <strong>Add client folder…</strong>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

function BriefEmptyState({
  busy,
  providerName,
  onGenerate,
  onImport,
}: {
  busy: boolean;
  providerName: string;
  onGenerate: () => void;
  onImport: () => void;
}) {
  return (
    <section className="brief-empty-state">
      <span className="brief-empty-icon">
        <FileText />
      </span>
      <div>
        <h2>Add a meeting brief</h2>
        <p>
          Generate one from your sources, or choose an existing Markdown file.
        </p>
      </div>
      <div className="brief-empty-actions">
        <button className="button primary" disabled={busy} onClick={onGenerate}>
          <Sparkles /> {busy ? "Generating…" : `Generate with ${providerName}`}
        </button>
        <button className="button secondary" disabled={busy} onClick={onImport}>
          Choose Markdown file
        </button>
      </div>
    </section>
  );
}

function BriefPreview({
  brief,
  busy,
  onOpen,
  onRefresh,
  onReplace,
  onRegenerate,
  onRemove,
}: {
  brief: NegotiationBrief;
  busy: boolean;
  onOpen: () => void;
  onRefresh: () => void;
  onReplace: () => void;
  onRegenerate: () => void;
  onRemove: () => void;
}) {
  return (
    <section className="prepare-section brief-preview-section">
      <div className="brief-preview-heading">
        <div>
          <h2>{brief.title}</h2>
          <p>
            {briefFileName(brief)} · Version {brief.version}
          </p>
        </div>
        <BriefActions
          busy={busy}
          path={brief.documentPath}
          onOpen={onOpen}
          onRefresh={onRefresh}
          onReplace={onReplace}
          onRegenerate={onRegenerate}
          onRemove={onRemove}
        />
      </div>
      <div className="brief-markdown-preview">
        {renderBriefMarkdown(
          brief.documentContent || `# ${brief.title}\n\n${brief.objective}`,
        )}
      </div>
    </section>
  );
}

function BriefActions({
  busy,
  path,
  onOpen,
  onRefresh,
  onReplace,
  onRegenerate,
  onRemove,
}: {
  busy: boolean;
  path: string | null;
  onOpen: () => void;
  onRefresh: () => void;
  onReplace: () => void;
  onRegenerate: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="brief-actions">
      <button
        className="button secondary"
        disabled={busy || !path}
        onClick={onOpen}
      >
        Open in editor
      </button>
      <button
        className="button secondary"
        disabled={busy || !path}
        onClick={onRefresh}
      >
        Refresh
      </button>
      <div className="brief-more" ref={ref}>
        <button
          className="icon-button"
          aria-label="More brief actions"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <MoreHorizontal />
        </button>
        {open && (
          <div className="brief-more-menu">
            <button
              disabled={!path}
              onClick={() => path && void revealPath(path)}
            >
              Reveal in Finder
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onReplace();
              }}
            >
              Replace Markdown file
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onRegenerate();
              }}
            >
              Regenerate
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onRemove();
              }}
            >
              Remove brief
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DisclosureButton({
  label,
  detail,
  open,
  controls,
  onClick,
}: {
  label: string;
  detail: string;
  open: boolean;
  controls: string;
  onClick: () => void;
}) {
  return (
    <button
      className="prepare-disclosure"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onClick}
    >
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <ChevronDown className={open ? "open" : ""} />
    </button>
  );
}

function briefFileName(brief: NegotiationBrief) {
  return brief.documentPath?.split(/[\\/]/).pop() ?? "Markdown brief";
}

function renderBriefMarkdown(markdown: string) {
  const elements: React.ReactNode[] = [];
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const Tag = `h${heading[1].length}` as "h1" | "h2" | "h3";
      elements.push(<Tag key={index}>{heading[2]}</Tag>);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*]\s+/, ""));
        index += 1;
      }
      index -= 1;
      elements.push(
        <ul key={index}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{item}</li>
          ))}
        </ul>,
      );
      continue;
    }
    elements.push(<p key={index}>{line}</p>);
  }
  // Deliberately minimal: add a Markdown dependency only when real briefs need richer syntax.
  return elements;
}

function SettingsGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-group">
      <h2 className="group-title">{title}</h2>
      <div className="group-card">{children}</div>
    </section>
  );
}

function RecommendationPreview({
  recommendation,
  onDismiss,
  onKeep,
  autoDismiss,
}: {
  recommendation: DashboardSnapshot["latestRecommendation"];
  onDismiss?: () => void;
  onKeep?: () => void;
  autoDismiss: boolean;
}) {
  const createdAt = recommendation?.createdAt;
  const expiresAt = recommendation?.expiresAt;
  const lifetimeStyle = useMemo(
    () =>
      createdAt && expiresAt && autoDismiss
        ? ({
            "--recommendation-lifetime": `${Math.min(MAX_RECOMMENDATION_DISPLAY_MS, Math.max(MIN_RECOMMENDATION_DISPLAY_MS, Date.parse(expiresAt) - Date.parse(createdAt)))}ms`,
          } as CSSProperties)
        : undefined,
    [autoDismiss, createdAt, expiresAt],
  );
  return (
    <section className="recommendation-card">
      <div className="recommendation-top">
        <span className="recommendation-title">
          <i /> Live recommendation
        </span>
        {onDismiss && (
          <button
            className={`recommendation-dismiss ${autoDismiss ? "auto-dismiss" : ""}`}
            type="button"
            onClick={autoDismiss ? onKeep : onDismiss}
            onAnimationEnd={autoDismiss ? onDismiss : undefined}
            style={lifetimeStyle}
            aria-label={
              autoDismiss
                ? "Keep recommendation open"
                : "Dismiss recommendation"
            }
            title={
              autoDismiss
                ? "Keep recommendation open"
                : "Dismiss recommendation"
            }
          >
            <span>{autoDismiss ? "Keep" : "Dismiss"}</span>
            {autoDismiss ? <Pause /> : <X />}
          </button>
        )}
      </div>
      <div className="say-block">
        <span>Say</span>
        <div className="recommendation-copy">
          <p>
            {recommendation?.say ??
              "Recommendations appear when the conversation reaches a meaningful decision point."}
          </p>
          {recommendation && (
            <small className="grounded-score">
              {Math.round(recommendation.groundingScore * 100)}% grounded
            </small>
          )}
        </div>
      </div>
      {recommendation?.avoid && (
        <div className="avoid-block">
          <span>Avoid</span>
          <p>{recommendation.avoid}</p>
        </div>
      )}
      {recommendation?.sources[0] && (
        <button className="source-button">
          ⌁ {recommendation.sources[0].relativePath}
          <span>↗</span>
        </button>
      )}
    </section>
  );
}

export function MeetingOverlay({
  session,
  turns,
  recommendation,
  onTogglePause,
  onRequestRecommendation,
  onStop,
  busy,
  error,
  style,
  position,
  showTranscript,
  thinking,
}: {
  session: DashboardSnapshot["activeSession"];
  turns: TranscriptTurn[];
  recommendation: DashboardSnapshot["latestRecommendation"];
  onTogglePause: () => void;
  onRequestRecommendation: () => void;
  onStop: () => void;
  busy: boolean;
  error: string | null;
  style: AppSettings["overlayStyle"];
  position: AppSettings["overlayPosition"];
  showTranscript: boolean;
  thinking: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [dismissedRecommendationId, setDismissedRecommendationId] = useState<
    string | null
  >(null);
  const [keptRecommendationId, setKeptRecommendationId] = useState<
    string | null
  >(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const paused = session?.state === "paused";
  const mascot = thinking
    ? { image: mascotThinking, state: "thinking" }
    : paused
      ? { image: mascotMuted, state: "muted" }
      : { image: mascotListening, state: "listening" };
  const lastTurn = turns[turns.length - 1];
  const recentTurns = turns.slice(-12);
  const hasText = showTranscript && Boolean(lastTurn);
  const visibleRecommendation =
    recommendation?.id === dismissedRecommendationId ? null : recommendation;
  const showExtension = Boolean(
    visibleRecommendation || error || confirmingStop,
  );
  const open = style === "live" && (hasText || showExtension);

  useEffect(() => {
    if (!session) return;
    const update = () => {
      const timestamp = Date.now();
      setElapsed(
        Math.max(
          0,
          Math.floor((timestamp - Date.parse(session.startedAt)) / 1_000),
        ),
      );
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    if (paused) return;
    const timer = window.setInterval(() => {
      void getAudioLevel().then((level) =>
        setAudioLevel(
          (current) => current * 0.6 + Math.min(1, level * 12) * 0.4,
        ),
      );
    }, 80);
    return () => window.clearInterval(timer);
  }, [paused, session]);

  useEffect(() => {
    if (hasText)
      transcriptRef.current?.scrollTo({
        top: transcriptRef.current.scrollHeight,
        behavior: "smooth",
      });
  }, [hasText, lastTurn?.text]);

  const elapsedLabel = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <main className={`ov-stage ${position}`}>
      <section
        className={`scard stream-card ${open ? "open" : ""} ${hasText ? "has-text" : ""} ${showExtension ? "ai-open" : ""} ${thinking ? "thinking" : ""} ${paused ? "paused" : ""}`}
      >
        <div className="stext" aria-live="polite">
          <div className="stext-clip">
            <div className="stext-cap" ref={transcriptRef}>
              <p>
                {recentTurns.map((turn, index) => (
                  <span className="transcript-fragment" key={turn.id}>
                    {(index === 0 ||
                      recentTurns[index - 1].channel !== turn.channel) && (
                      <span className="speaker-label">
                        {turn.channel === "other" ? (
                          "System audio"
                        ) : turn.channel === "selfSpeaker" ? (
                          "Microphone"
                        ) : (
                          <em>Transcribe</em>
                        )}
                      </span>
                    )}
                    <span className={turn.isFinal ? "committed" : "interim"}>
                      {turn.text}
                    </span>{" "}
                  </span>
                ))}
                <span className="scaret" />
              </p>
            </div>
          </div>
        </div>

        <div className="ai-extension">
          <div className="ai-extension-clip">
            {visibleRecommendation && (
              <RecommendationPreview
                recommendation={visibleRecommendation}
                onDismiss={() =>
                  setDismissedRecommendationId(visibleRecommendation.id)
                }
                onKeep={() => setKeptRecommendationId(visibleRecommendation.id)}
                autoDismiss={visibleRecommendation.id !== keptRecommendationId}
              />
            )}
            {confirmingStop && (
              <div className="stop-confirmation" role="alert">
                <p>
                  Stop this meeting? Savvy will stop capturing the transcript
                  and any further insights.
                </p>
                <div>
                  <button
                    type="button"
                    onClick={() => setConfirmingStop(false)}
                  >
                    Keep listening
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setConfirmingStop(false);
                      onStop();
                    }}
                  >
                    Stop meeting
                  </button>
                </div>
              </div>
            )}
            {error && <p className="overlay-error">{error}</p>}
          </div>
        </div>

        <div className="overlay-status" role="status">
          <span className="overlay-status-copy">
            <img
              className={`mascot-state ${mascot.state}`}
              src={mascot.image}
              alt=""
              width="26"
              height="26"
              draggable="false"
            />
            {thinking
              ? "Savvy is thinking"
              : paused
                ? "Savvy is muted"
                : "Savvy is listening"}
          </span>
          {lastTurn && (
            <button
              className={`sx srecommend ${thinking ? "thinking" : ""}`}
              onClick={onRequestRecommendation}
              disabled={thinking || busy || !session}
              aria-label="Get recommendation now"
              title="Get recommendation now"
            >
              <Sparkles />
              <span>{thinking ? "Thinking…" : "Advice"}</span>
            </button>
          )}
        </div>

        <div
          className="sbase"
          onMouseDown={(event) => {
            if (
              event.button === 0 &&
              !(event.target as HTMLElement).closest("button") &&
              window.__TAURI_INTERNALS__
            ) {
              void getCurrentWindow().startDragging();
            }
          }}
        >
          <h1 className="sr-only">Live transcript</h1>
          <div className="sbase-l">
            <button
              className="sx spause"
              onClick={onTogglePause}
              disabled={busy || !session}
              aria-label={paused ? "Unmute microphone" : "Mute microphone"}
              title={paused ? "Unmute microphone" : "Mute microphone"}
            >
              {paused ? <Mic /> : <MicOff />}
            </button>
          </div>
          <div className="swave" aria-hidden="true">
            {[0.35, 0.55, 0.8, 1, 0.7, 0.9, 0.6, 0.45, 0.3].map(
              (weight, index) => (
                <i
                  key={index}
                  style={{
                    height: `${3 + (paused ? 0 : audioLevel) * weight * 15}px`,
                  }}
                />
              ),
            )}
          </div>
          <div className="sbase-r">
            <span className="stimer">{elapsedLabel}</span>
            <button
              className="sx sstop"
              onClick={() => setConfirmingStop(true)}
              disabled={busy || !session}
              aria-label="Stop meeting"
              title="Stop meeting"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect
                  x="4"
                  y="4"
                  width="8"
                  height="8"
                  rx="1.2"
                  fill="currentColor"
                />
              </svg>
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

function HistoryView() {
  const [meetings, setMeetings] = useState<MeetingHistoryItem[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MeetingHistoryItem | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    void getMeetingHistory()
      .then(setMeetings)
      .catch((reason: unknown) =>
        setHistoryError(
          reason instanceof Error ? reason.message : String(reason),
        ),
      );
  }, []);

  return (
    <div className="page-content">
      <section className="settings-group">
        <div className="history-heading">
          <h2 className="group-title">Meeting history</h2>
          <button
            className="button"
            onClick={() => void openRecordingsFolder()}
          >
            <FolderOpen width={13} height={13} /> Open recordings
          </button>
        </div>
        <div className="group-card">
          {historyError ? (
            <p className="settings-error">{historyError}</p>
          ) : meetings === null ? (
            <div className="history-empty">Loading meetings…</div>
          ) : meetings.length === 0 ? (
            <div className="history-empty">
              <span className="large-mark">
                <History width={23} height={23} />
              </span>
              <h1>Your recordings stay on this Mac</h1>
              <p>Completed meeting transcripts and insights appear here.</p>
            </div>
          ) : (
            meetings.map((meeting) => (
              <MeetingHistoryRow
                meeting={meeting}
                key={meeting.session.id}
                onDelete={() => setPendingDelete(meeting)}
              />
            ))
          )}
        </div>
      </section>
      {pendingDelete && (
        <div className="modal-backdrop">
          <section
            className="confirmation-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-meeting-title"
          >
            <h2 id="delete-meeting-title">Delete meeting?</h2>
            <p>
              <strong>Are you sure?</strong> The recording, transcript, and
              insights will be permanently removed.
            </p>
            <div>
              <button
                className="button"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                autoFocus
              >
                Cancel
              </button>
              <button
                className="button danger"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  setHistoryError(null);
                  try {
                    await deleteMeeting(pendingDelete.session.id);
                    setMeetings(
                      (current) =>
                        current?.filter(
                          ({ session }) =>
                            session.id !== pendingDelete.session.id,
                        ) ?? [],
                    );
                    setPendingDelete(null);
                  } catch (reason) {
                    setHistoryError(
                      reason instanceof Error ? reason.message : String(reason),
                    );
                  } finally {
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function MeetingHistoryRow({
  meeting,
  onDelete,
}: {
  meeting: MeetingHistoryItem;
  onDelete: () => void;
}) {
  const started = new Date(meeting.session.startedAt);
  const ended = meeting.session.endedAt
    ? new Date(meeting.session.endedAt)
    : null;
  const duration = ended
    ? Math.max(0, Math.round((ended.getTime() - started.getTime()) / 60_000))
    : null;

  return (
    <article className="history-meeting">
      <header>
        <span>
          <strong>{meeting.clientName}</strong>
          <small>
            {started.toLocaleString()} · {duration ?? "—"} min ·{" "}
            {meeting.session.state}
          </small>
        </span>
        <div className="history-actions">
          <button
            className="button history-transcript-button"
            onClick={() => void openMeetingTranscript(meeting.session.id)}
          >
            <FolderOpen width={13} height={13} /> Show transcript file
          </button>
          <button
            className="history-meeting-delete"
            onClick={onDelete}
            aria-label="Delete meeting"
            title="Delete meeting"
          >
            <Trash2 width={13} />
          </button>
        </div>
      </header>
      <MeetingAudioPlayer path={meeting.session.audioPath} />
    </article>
  );
}

function MeetingAudioPlayer({ path }: { path: string | null }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  if (!path)
    return <small className="history-audio-missing">Audio unavailable</small>;
  const source = window.__TAURI_INTERNALS__ ? convertFileSrc(path) : path;

  function togglePlayback() {
    const player = audio.current;
    if (!player) return;
    if (player.paused) {
      document.querySelectorAll("audio").forEach((other) => {
        if (other !== player) other.pause();
      });
      void player.play();
    } else {
      player.pause();
    }
  }

  return (
    <div className="history-audio-player">
      <audio
        ref={audio}
        src={source}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
      />
      <button
        className="history-audio-play"
        onClick={togglePlayback}
        aria-label={playing ? "Pause recording" : "Play recording"}
      >
        {playing ? (
          <Pause width={13} fill="currentColor" />
        ) : (
          <Play width={13} fill="currentColor" />
        )}
      </button>
      <span>{formatAudioTime(position)}</span>
      <input
        aria-label="Recording position"
        type="range"
        min="0"
        max={duration || 0}
        step="0.1"
        value={Math.min(position, duration || 0)}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (audio.current) audio.current.currentTime = next;
          setPosition(next);
        }}
      />
      <span>{formatAudioTime(duration)}</span>
    </div>
  );
}

function formatAudioTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

const codexModelOptions = [
  { value: "default", label: "Codex default" },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
];

const claudeModelOptions = [
  { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { value: "claude-opus-5", label: "Claude Opus 5" },
  { value: "claude-fable-5", label: "Claude Fable 5" },
];

const codexServiceTiers = [
  { value: "default", label: "Standard" },
  { value: "priority", label: "Fast" },
];

const claudeContextWindows = [
  { value: "200k", label: "200k" },
  { value: "1m", label: "1M" },
];

const transcriptionProviders = [
  { value: "deepgram", label: "Deepgram" },
  { value: "assemblyAi", label: "AssemblyAI" },
];

// Ordered by Whisper's training-data ranking, which is roughly descending
// speaker count. Savvy no longer uses Whisper, so this is now just a stable
// presentation order; it is filtered below by the selected transcription
// model's real capabilities.
const conversationLanguages = [
  { value: "multi", label: "Auto Detect" },
  { value: "en", label: "English" },
  { value: "zh-Hans", label: "Chinese (Simplified)" },
  { value: "zh-Hant", label: "Chinese (Traditional)" },
  { value: "yue", label: "Cantonese" },
  { value: "de", label: "German" },
  { value: "es", label: "Spanish" },
  { value: "ru", label: "Russian" },
  { value: "ko", label: "Korean" },
  { value: "fr", label: "French" },
  { value: "ja", label: "Japanese" },
  { value: "pt", label: "Portuguese" },
  { value: "tr", label: "Turkish" },
  { value: "pl", label: "Polish" },
  { value: "ca", label: "Catalan" },
  { value: "nl", label: "Dutch" },
  { value: "ar", label: "Arabic" },
  { value: "sv", label: "Swedish" },
  { value: "it", label: "Italian" },
  { value: "id", label: "Indonesian" },
  { value: "hi", label: "Hindi" },
  { value: "fi", label: "Finnish" },
  { value: "vi", label: "Vietnamese" },
  { value: "he", label: "Hebrew" },
  { value: "uk", label: "Ukrainian" },
  { value: "el", label: "Greek" },
  { value: "ms", label: "Malay" },
  { value: "cs", label: "Czech" },
  { value: "ro", label: "Romanian" },
  { value: "da", label: "Danish" },
  { value: "hu", label: "Hungarian" },
  { value: "ta", label: "Tamil" },
  { value: "no", label: "Norwegian" },
  { value: "th", label: "Thai" },
  { value: "ur", label: "Urdu" },
  { value: "hr", label: "Croatian" },
  { value: "bg", label: "Bulgarian" },
  { value: "lt", label: "Lithuanian" },
  { value: "la", label: "Latin" },
  { value: "mi", label: "Maori" },
  { value: "ml", label: "Malayalam" },
  { value: "cy", label: "Welsh" },
  { value: "sk", label: "Slovak" },
  { value: "te", label: "Telugu" },
  { value: "fa", label: "Persian" },
  { value: "lv", label: "Latvian" },
  { value: "bn", label: "Bengali" },
  { value: "sr", label: "Serbian" },
  { value: "az", label: "Azerbaijani" },
  { value: "sl", label: "Slovenian" },
  { value: "kn", label: "Kannada" },
  { value: "et", label: "Estonian" },
  { value: "mk", label: "Macedonian" },
  { value: "br", label: "Breton" },
  { value: "eu", label: "Basque" },
  { value: "is", label: "Icelandic" },
  { value: "hy", label: "Armenian" },
  { value: "ne", label: "Nepali" },
  { value: "mn", label: "Mongolian" },
  { value: "bs", label: "Bosnian" },
  { value: "kk", label: "Kazakh" },
  { value: "sq", label: "Albanian" },
  { value: "sw", label: "Swahili" },
  { value: "gl", label: "Galician" },
  { value: "mr", label: "Marathi" },
  { value: "pa", label: "Punjabi" },
  { value: "si", label: "Sinhala" },
  { value: "km", label: "Khmer" },
  { value: "sn", label: "Shona" },
  { value: "yo", label: "Yoruba" },
  { value: "so", label: "Somali" },
  { value: "af", label: "Afrikaans" },
  { value: "oc", label: "Occitan" },
  { value: "ka", label: "Georgian" },
  { value: "be", label: "Belarusian" },
  { value: "tg", label: "Tajik" },
  { value: "sd", label: "Sindhi" },
  { value: "gu", label: "Gujarati" },
  { value: "am", label: "Amharic" },
  { value: "yi", label: "Yiddish" },
  { value: "lo", label: "Lao" },
  { value: "uz", label: "Uzbek" },
  { value: "fo", label: "Faroese" },
  { value: "ht", label: "Haitian Creole" },
  { value: "ps", label: "Pashto" },
  { value: "tk", label: "Turkmen" },
  { value: "nn", label: "Nynorsk" },
  { value: "mt", label: "Maltese" },
  { value: "sa", label: "Sanskrit" },
  { value: "lb", label: "Luxembourgish" },
  { value: "my", label: "Myanmar" },
  { value: "bo", label: "Tibetan" },
  { value: "tl", label: "Tagalog" },
  { value: "mg", label: "Malagasy" },
  { value: "as", label: "Assamese" },
  { value: "tt", label: "Tatar" },
  { value: "haw", label: "Hawaiian" },
  { value: "ln", label: "Lingala" },
  { value: "ha", label: "Hausa" },
  { value: "ba", label: "Bashkir" },
  { value: "jw", label: "Javanese" },
  { value: "su", label: "Sundanese" },
];

const transcriptionModels: Record<
  AppSettings["transcriptionProvider"],
  Array<{
    value: string;
    label: string;
    languages: string[];
  }>
> = {
  deepgram: [
    {
      value: "nova-3",
      label: "Nova-3",
      languages: [
        "multi",
        "ar",
        "ar-AE",
        "ar-SA",
        "ar-QA",
        "ar-KW",
        "ar-SY",
        "ar-LB",
        "ar-PS",
        "ar-JO",
        "ar-EG",
        "ar-SD",
        "ar-TD",
        "ar-MA",
        "ar-DZ",
        "ar-TN",
        "ar-IQ",
        "ar-IR",
        "be",
        "bn",
        "bs",
        "bg",
        "ca",
        "zh-HK",
        "zh",
        "zh-CN",
        "zh-Hans",
        "zh-TW",
        "zh-Hant",
        "hr",
        "cs",
        "da",
        "da-DK",
        "nl",
        "nl-BE",
        "en",
        "en-US",
        "en-AU",
        "en-GB",
        "en-IN",
        "en-NZ",
        "et",
        "fi",
        "fr",
        "fr-CA",
        "de",
        "de-CH",
        "el",
        "gu",
        "gu-IN",
        "he",
        "hi",
        "hu",
        "id",
        "it",
        "ja",
        "kn",
        "ko",
        "ko-KR",
        "lv",
        "lt",
        "mk",
        "ms",
        "mr",
        "no",
        "fa",
        "pl",
        "pt",
        "pt-BR",
        "pt-PT",
        "ro",
        "ru",
        "sr",
        "sk",
        "sl",
        "es",
        "es-419",
        "sv",
        "sv-SE",
        "tl",
        "ta",
        "te",
        "th",
        "th-TH",
        "tr",
        "uk",
        "ur",
        "vi",
      ],
    },
    {
      value: "nova-3-medical",
      label: "Nova-3 Medical",
      languages: [
        "en",
        "en-US",
        "en-AU",
        "en-CA",
        "en-GB",
        "en-IE",
        "en-IN",
        "en-NZ",
      ],
    },
    {
      value: "nova-2",
      label: "Nova-2",
      languages: [
        "multi",
        "bg",
        "ca",
        "zh",
        "zh-CN",
        "zh-Hans",
        "zh-TW",
        "zh-Hant",
        "zh-HK",
        "cs",
        "da",
        "da-DK",
        "nl",
        "nl-BE",
        "en",
        "en-US",
        "en-AU",
        "en-GB",
        "en-NZ",
        "en-IN",
        "et",
        "fi",
        "fr",
        "fr-CA",
        "de",
        "de-CH",
        "el",
        "hi",
        "hu",
        "id",
        "it",
        "ja",
        "ko",
        "ko-KR",
        "lv",
        "lt",
        "ms",
        "no",
        "pl",
        "pt",
        "pt-BR",
        "pt-PT",
        "ro",
        "ru",
        "sk",
        "es",
        "es-419",
        "sv",
        "sv-SE",
        "th",
        "th-TH",
        "tr",
        "uk",
        "vi",
      ],
    },
    {
      value: "nova-2-conversationalai",
      label: "Nova-2 Conversational AI",
      languages: ["en", "en-US"],
    },
    {
      value: "nova-2-medical",
      label: "Nova-2 Medical",
      languages: ["en", "en-US"],
    },
    {
      value: "nova-2-phonecall",
      label: "Nova-2 Phone Call",
      languages: ["en", "en-US"],
    },
  ],
  assemblyAi: [
    {
      value: "u3-rt-pro",
      label: "Universal-3 Pro Streaming",
      languages: ["multi", "en", "es", "fr", "de", "it", "pt"],
    },
    {
      value: "universal-streaming-english",
      label: "Universal Streaming English",
      languages: ["en"],
    },
    {
      value: "universal-streaming-multilingual",
      label: "Universal Streaming Multilingual",
      languages: ["multi"],
    },
    {
      value: "whisper-rt",
      label: "Whisper Streaming",
      languages: ["multi"],
    },
  ],
};

function languageOptions(
  model: (typeof transcriptionModels)[AppSettings["transcriptionProvider"]][number],
) {
  return conversationLanguages.filter(({ value }) =>
    model.languages.includes(value),
  );
}

function SettingsView({
  section,
  settings,
  version,
  saving,
  onSave,
}: {
  section: View;
  settings: AppSettings | null;
  version: string;
  saving: boolean;
  onSave: (patch: Partial<AppSettings>) => Promise<boolean>;
}) {
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [outputs, setOutputs] = useState<AudioDevice[]>([]);
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const [keyStatus, setKeyStatus] = useState<TranscriptionKeyStatus | null>(
    null,
  );
  const [providerHealth, setProviderHealth] = useState<ProviderHealth[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  useEffect(() => {
    if (section !== "general") return;
    let cancelled = false;
    Promise.all([getInputDevices(), getOutputDevices()])
      .then(([nextInputs, nextOutputs]) => {
        if (cancelled) return;
        setInputs(nextInputs);
        setOutputs(nextOutputs);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [section]);

  useEffect(() => {
    if (section !== "models") return;
    let cancelled = false;
    void getTranscriptionKeyStatus()
      .then((status) => {
        if (!cancelled) setKeyStatus(status);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setKeyError(
            reason instanceof Error ? reason.message : String(reason),
          );
        }
      });
    void getRecommendationProviderStatus()
      .then((status) => {
        if (!cancelled) setProviderHealth(status);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [section]);

  useEffect(() => {
    if (section !== "about") return;
    let cancelled = false;
    getAppPaths()
      .then((nextPaths) => {
        if (!cancelled) setPaths(nextPaths);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [section]);

  if (!settings) return <LoadingState />;
  const selectedInput =
    inputs.find((device) =>
      settings.selectedMicrophone
        ? device.name === settings.selectedMicrophone
        : device.isDefault,
    ) ?? inputs[0];

  if (section === "general") {
    return (
      <div className="page-content preference-page">
        <SettingsGroup title="General">
          <PreferenceRow
            title="Start Listening"
            detail="The keyboard shortcut to start or stop listening."
          >
            <ShortcutEditor
              value={settings.startListeningShortcut}
              disabled={saving}
              onChange={(value) => onSave({ startListeningShortcut: value })}
            />
          </PreferenceRow>
        </SettingsGroup>
        <SettingsGroup title="Sound">
          <SettingSelect
            title="Microphone"
            detail="Select your preferred microphone device."
            value={settings.selectedMicrophone ?? ""}
            disabled={saving}
            options={inputs.map((device) => ({
              value: device.isDefault ? "" : device.name,
              label: device.name,
            }))}
            onChange={(value) =>
              onSave({
                selectedMicrophone: value || null,
                selectedChannel: null,
              })
            }
          />
          <SettingSelect
            title="Input Channel"
            detail="Choose one input channel or capture all available channels."
            value={settings.selectedChannel?.toString() ?? ""}
            disabled={saving || !selectedInput}
            options={[
              { value: "", label: "Average all channels" },
              ...Array.from(
                { length: selectedInput?.channels ?? 0 },
                (_, index) => ({
                  value: index.toString(),
                  label: `Channel ${index + 1}`,
                }),
              ),
            ]}
            onChange={(value) =>
              onSave({
                selectedChannel: value === "" ? null : Number(value),
              })
            }
          />
          <ToggleSetting
            title="Audio Feedback"
            detail="Play a short cue when listening starts and stops."
            checked={settings.audioFeedback}
            disabled={saving}
            onChange={(audioFeedback) => onSave({ audioFeedback })}
          />
          <SettingSelect
            title="Output Device"
            detail="Select the output device for listening cues."
            value={settings.selectedOutputDevice ?? ""}
            disabled={saving || !settings.audioFeedback}
            options={outputs.map((device) => ({
              value: device.isDefault ? "" : device.name,
              label: device.name,
            }))}
            onChange={(value) =>
              onSave({ selectedOutputDevice: value || null })
            }
          />
          <PreferenceRow
            title="Volume"
            detail="Adjust the volume of audio feedback sounds."
            disabled={!settings.audioFeedback}
          >
            <label className="volume-control">
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={settings.audioFeedbackVolume}
                disabled={saving || !settings.audioFeedback}
                onChange={(event) =>
                  onSave({
                    audioFeedbackVolume: Number(event.target.value),
                  })
                }
                aria-label="Volume"
              />
              <span>{Math.round(settings.audioFeedbackVolume * 100)}%</span>
            </label>
          </PreferenceRow>
        </SettingsGroup>
      </div>
    );
  }

  if (section === "models") {
    const selectedProvider = settings.transcriptionProvider;
    const selectedTranscriptionModel =
      transcriptionModels[selectedProvider].find(
        (model) => model.value === settings.transcriptionModel,
      ) ?? transcriptionModels[selectedProvider][0];
    const configured = keyStatus?.[selectedProvider] ?? false;
    return (
      <div className="page-content preference-page">
        <SettingsGroup title="Live Transcript">
          <SettingSelect
            title="Transcription Provider"
            detail="Choose the service that turns microphone audio into live transcript text."
            value={selectedProvider}
            disabled={saving || keyBusy}
            options={transcriptionProviders}
            onChange={(value) => {
              const transcriptionProvider =
                value as AppSettings["transcriptionProvider"];
              const model = transcriptionModels[transcriptionProvider][0];
              setApiKey("");
              setKeyError(null);
              void onSave({
                transcriptionProvider,
                transcriptionModel: model.value,
                transcriptionLanguage: model.languages[0],
              });
            }}
          />
          <SettingSelect
            title="Transcription Model"
            detail="Choose the streaming speech-to-text model used during meetings."
            value={settings.transcriptionModel}
            disabled={saving || keyBusy}
            options={transcriptionModels[selectedProvider]}
            onChange={(transcriptionModel) => {
              const model = transcriptionModels[selectedProvider].find(
                (candidate) => candidate.value === transcriptionModel,
              );
              if (!model) return;
              void onSave({
                transcriptionModel,
                ...(!model.languages.includes(settings.transcriptionLanguage)
                  ? { transcriptionLanguage: model.languages[0] }
                  : {}),
              });
            }}
          />
          <SettingSelect
            title="Conversation Language"
            detail="Choose the primary language being spoken, or use automatic multilingual transcription."
            value={settings.transcriptionLanguage}
            disabled={saving || keyBusy}
            options={languageOptions(selectedTranscriptionModel)}
            searchable
            onChange={(transcriptionLanguage) =>
              onSave({ transcriptionLanguage })
            }
          />
          <PreferenceRow
            title="API Key"
            detail="Saved securely in macOS Keychain and never written to Savvy settings."
            disabled={keyBusy}
          >
            <span className="credential-control">
              <input
                type="password"
                value={apiKey}
                disabled={keyBusy}
                aria-label={`${transcriptionProviders.find((item) => item.value === selectedProvider)?.label} API key`}
                placeholder={configured ? "Configured" : "Enter API key"}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setKeyError(null);
                }}
              />
              <button
                type="button"
                disabled={keyBusy || !apiKey.trim()}
                onClick={() => {
                  setKeyBusy(true);
                  setKeyError(null);
                  void setTranscriptionApiKey(selectedProvider, apiKey)
                    .then((status) => {
                      setKeyStatus(status);
                      setApiKey("");
                    })
                    .catch((reason: unknown) =>
                      setKeyError(
                        reason instanceof Error
                          ? reason.message
                          : String(reason),
                      ),
                    )
                    .finally(() => setKeyBusy(false));
                }}
              >
                Save
              </button>
              {configured && (
                <button
                  type="button"
                  className="credential-remove"
                  disabled={keyBusy}
                  onClick={() => {
                    setKeyBusy(true);
                    setKeyError(null);
                    void deleteTranscriptionApiKey(selectedProvider)
                      .then((status) => {
                        setKeyStatus(status);
                        setApiKey("");
                      })
                      .catch((reason: unknown) =>
                        setKeyError(
                          reason instanceof Error
                            ? reason.message
                            : String(reason),
                        ),
                      )
                      .finally(() => setKeyBusy(false));
                  }}
                >
                  Remove
                </button>
              )}
            </span>
          </PreferenceRow>
          {keyError && <p className="settings-error">{keyError}</p>}
        </SettingsGroup>
        <SettingsGroup title="Reasoning Models">
          <div
            className="reasoning-provider-picker"
            role="group"
            aria-label="Reasoning provider"
          >
            {reasoningProviders.map((provider) => {
              const health = providerHealth.find(
                (candidate) => candidate.provider === provider.value,
              );
              const ready = Boolean(
                health?.available && health.credentialPresent,
              );
              const Icon = provider.icon;
              return (
                <button
                  type="button"
                  className={
                    settings.recommendationProvider === provider.value
                      ? "selected"
                      : ""
                  }
                  disabled={saving || !ready}
                  title={health?.message ?? "Checking provider…"}
                  aria-label={`${provider.label}: ${health?.message ?? "Checking provider"}`}
                  aria-pressed={
                    settings.recommendationProvider === provider.value
                  }
                  key={provider.value}
                  onClick={() =>
                    onSave({
                      recommendationProvider:
                        provider.value as AppSettings["recommendationProvider"],
                    })
                  }
                >
                  <span className="reasoning-provider-icon">
                    <Icon
                      className={`provider-logo ${provider.value}`}
                      aria-hidden="true"
                    />
                    <span
                      className={`provider-status-dot ${health ? (ready ? "ready" : "error") : "checking"}`}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="reasoning-provider-copy">
                    <strong>{provider.label}</strong>
                    <small>
                      {health?.message ?? "Checking provider status"}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
          <SettingSelect
            title="Reasoning Model"
            detail="Choose the reasoning model used to generate live guidance."
            value={
              settings.recommendationProvider === "claude"
                ? settings.claudeModel
                : settings.codexModel
            }
            disabled={saving}
            options={
              settings.recommendationProvider === "claude"
                ? claudeModelOptions
                : codexModelOptions
            }
            onChange={(value) =>
              onSave(
                settings.recommendationProvider === "claude"
                  ? { claudeModel: value as AppSettings["claudeModel"] }
                  : { codexModel: value as AppSettings["codexModel"] },
              )
            }
          />
          {settings.recommendationProvider === "claude" ? (
            <SettingSelect
              title="Context Window"
              detail="Choose Claude's 200k or 1M context-window model variant."
              value={settings.claudeContextWindow}
              disabled={saving}
              options={claudeContextWindows}
              onChange={(value) =>
                onSave({
                  claudeContextWindow:
                    value as AppSettings["claudeContextWindow"],
                })
              }
            />
          ) : (
            <SettingSelect
              title="Service Tier"
              detail="Choose Standard or Fast processing for Codex reasoning."
              value={settings.codexServiceTier}
              disabled={saving}
              options={codexServiceTiers}
              onChange={(value) =>
                onSave({
                  codexServiceTier: value as AppSettings["codexServiceTier"],
                })
              }
            />
          )}
        </SettingsGroup>
      </div>
    );
  }

  if (section === "advanced") {
    return (
      <div className="page-content preference-page">
        <SettingsGroup title="App">
          <ToggleSetting
            title="Start Hidden"
            detail="Launch to the menu bar without opening the window."
            checked={settings.startHidden}
            disabled={saving}
            onChange={(startHidden) => onSave({ startHidden })}
          />
          <ToggleSetting
            title="Launch on Startup"
            detail="Automatically start Savvy when you log in to this Mac."
            checked={settings.launchOnStartup}
            disabled={saving}
            onChange={(launchOnStartup) => onSave({ launchOnStartup })}
          />
          <ToggleSetting
            title="Show Tray Icon"
            detail="Show Savvy in the macOS menu bar."
            checked={settings.showTrayIcon}
            disabled={saving}
            onChange={(showTrayIcon) => onSave({ showTrayIcon })}
          />
          <SettingSelect
            title="Overlay"
            detail="Choose between the compact listening pill and live recommendations."
            value={settings.overlayStyle}
            disabled={saving}
            options={[
              { value: "minimal", label: "Minimal" },
              { value: "live", label: "Live" },
            ]}
            onChange={(value) =>
              onSave({ overlayStyle: value as AppSettings["overlayStyle"] })
            }
          />
          <SettingSelect
            title="Overlay Position"
            detail="Choose where the recording overlay appears on screen."
            value={settings.overlayPosition}
            disabled={saving}
            options={[
              { value: "bottom", label: "Bottom" },
              { value: "top", label: "Top" },
            ]}
            onChange={(value) =>
              onSave({
                overlayPosition: value as AppSettings["overlayPosition"],
              })
            }
          />
          <ToggleSetting
            title="Show Live Transcript"
            detail="Show the latest transcript text above the meeting controls."
            checked={settings.showLiveTranscript}
            disabled={saving}
            onChange={(showLiveTranscript) => onSave({ showLiveTranscript })}
          />
        </SettingsGroup>
        <SettingsGroup title="Output">
          <SettingSelect
            title="Recommendation Output"
            detail="Show recommendations beside the live transcript."
            value="overlay"
            options={[{ value: "overlay", label: "Overlay" }]}
            onChange={() => undefined}
          />
          <SettingSelect
            title="Provider Failure"
            detail="Keeps recording and falls back to your brief's hard constraints if the reasoning provider is unavailable."
            value="local"
            options={[{ value: "local", label: "Local fallback" }]}
            onChange={() => undefined}
          />
        </SettingsGroup>
      </div>
    );
  }

  return (
    <div className="page-content preference-page">
      <SettingsGroup title="About">
        <SettingSelect
          title="Application Theme"
          detail="Choose whether Savvy follows your system theme or stays light or dark."
          value={settings.theme}
          disabled={saving}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          onChange={(value) => onSave({ theme: value as AppSettings["theme"] })}
        />
        <PreferenceValue
          title="Version"
          detail="Current version of Savvy."
          value={<span className="version-value">v{version}</span>}
        />
        <DirectorySetting
          title="App Data Directory"
          detail="Location where Savvy stores its data."
          path={paths?.appDataDirectory ?? "Loading…"}
          disabled={!paths}
        />
        <DirectorySetting
          title="Log Directory"
          detail="Location where Savvy stores its log files."
          path={paths?.logDirectory ?? "Loading…"}
          disabled={!paths}
        />
      </SettingsGroup>
    </div>
  );
}

function PreferenceRow({
  title,
  detail,
  disabled = false,
  children,
}: {
  title: string;
  detail: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`setting-row preference-row ${disabled ? "disabled" : ""}`}>
      <span className="preference-label">
        <strong>{title}</strong>
        <InfoTooltip title={title} detail={detail} />
      </span>
      <span className="setting-value">{children}</span>
    </div>
  );
}

function DirectorySetting({
  title,
  detail,
  path,
  disabled,
}: {
  title: string;
  detail: string;
  path: string;
  disabled: boolean;
}) {
  return (
    <div
      className={`setting-row preference-row directory-setting ${disabled ? "disabled" : ""}`}
    >
      <span className="preference-label">
        <strong>{title}</strong>
        <InfoTooltip title={title} detail={detail} />
      </span>
      <span className="path-display">
        <code title={path}>{path}</code>
        <button
          type="button"
          disabled={disabled}
          onClick={() => void revealPath(path)}
        >
          Open
        </button>
      </span>
    </div>
  );
}

function GuidanceFolderSetting({
  path,
  disabled,
  onSave,
}: {
  path: string | null;
  disabled: boolean;
  onSave: (patch: Partial<AppSettings>) => Promise<boolean>;
}) {
  return (
    <div
      className={`setting-row preference-row directory-setting ${disabled ? "disabled" : ""}`}
    >
      <span className="preference-label">
        <strong>Guidance Library</strong>
        <InfoTooltip
          title="Guidance Library"
          detail="Reusable guidance applied to every meeting. Every subfolder is scanned; PDF, Word, PowerPoint, Excel, CSV, Markdown, text, and EPUB files are indexed."
        />
      </span>
      <span className="path-display">
        <code title={path ?? undefined}>{path ?? "Not selected"}</code>
        {path && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void revealPath(path)}
          >
            Open
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            void chooseGuidanceFolder().then((guidanceFolder) => {
              if (guidanceFolder) void onSave({ guidanceFolder });
            })
          }
        >
          Choose
        </button>
        {path && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void onSave({ guidanceFolder: null })}
          >
            Clear
          </button>
        )}
      </span>
    </div>
  );
}

function InfoTooltip({ title, detail }: { title: string; detail: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="info-tooltip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="info-button"
        aria-label={`${title}: ${detail}`}
        onClick={() => setOpen((current) => !current)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <Info width={14} height={14} strokeWidth={2} />
      </button>
      {open && (
        <span className="info-tooltip-bubble" role="tooltip">
          {detail}
        </span>
      )}
    </span>
  );
}

function SettingSelect({
  title,
  detail,
  value,
  options,
  disabled = false,
  searchable = false,
  onChange,
}: {
  title: string;
  detail: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  searchable?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <PreferenceRow title={title} detail={detail} disabled={disabled}>
      <Dropdown
        selectedValue={value}
        disabled={disabled}
        options={options}
        onSelect={onChange}
        label={title}
        searchable={searchable}
      />
    </PreferenceRow>
  );
}

function ToggleSetting({
  title,
  detail,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  detail: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <PreferenceRow title={title} detail={detail} disabled={disabled}>
      <button
        type="button"
        className={`toggle ${checked ? "on" : ""}`}
        role="switch"
        aria-label={title}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <i />
      </button>
    </PreferenceRow>
  );
}

function ShortcutEditor({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => Promise<boolean>;
}) {
  const [recording, setRecording] = useState(false);
  const controlRef = useRef<HTMLSpanElement>(null);
  const pressedKeys = useRef(new Set<string>());
  const pendingShortcut = useRef<string | null>(null);

  useEffect(() => {
    if (!recording) return;

    function resetCapture() {
      pressedKeys.current.clear();
      pendingShortcut.current = null;
      setRecording(false);
    }

    function cancelCapture() {
      resetCapture();
      void setShortcutRecording(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.repeat) return;
      event.preventDefault();
      pressedKeys.current.add(event.code || event.key);
      if (event.key === "Escape") {
        cancelCapture();
        return;
      }
      if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
      pendingShortcut.current = [
        event.metaKey ? "Command" : "",
        event.ctrlKey ? "Control" : "",
        event.altKey ? "Option" : "",
        event.shiftKey ? "Shift" : "",
        event.key === " "
          ? "Space"
          : event.key.length === 1
            ? event.key.toUpperCase()
            : event.key,
      ]
        .filter(Boolean)
        .join("+");
    }

    function handleKeyUp(event: KeyboardEvent) {
      event.preventDefault();
      pressedKeys.current.delete(event.code || event.key);
      if (pressedKeys.current.size > 0 || !pendingShortcut.current) return;
      const shortcut = pendingShortcut.current;
      resetCapture();
      void onChange(shortcut)
        .finally(() => setShortcutRecording(false))
        .catch(() => undefined);
    }

    function handleClickOutside(event: MouseEvent) {
      if (!controlRef.current?.contains(event.target as Node)) cancelCapture();
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("mousedown", handleClickOutside);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onChange, recording]);

  return (
    <span className="shortcut-control" ref={controlRef}>
      <button
        type="button"
        className={`shortcut-chip ${recording ? "recording" : ""}`}
        disabled={disabled}
        aria-label="Change start listening shortcut"
        onClick={() => {
          void setShortcutRecording(true)
            .then(() => setRecording(true))
            .catch(() => undefined);
        }}
      >
        {recording ? "Press keys…" : formatShortcut(value)}
      </button>
      <button
        type="button"
        className="reset-button"
        title="Reset shortcut"
        aria-label="Reset shortcut"
        disabled={disabled || recording}
        onClick={() => void onChange("Command+Shift+M")}
      >
        <RotateCcw width={13} height={13} />
      </button>
    </span>
  );
}

function formatShortcut(value: string) {
  return value
    .replace("Command", "⌘")
    .replace("Control", "⌃")
    .replace("Option", "⌥")
    .replace("Shift", "⇧")
    .split("+")
    .join(" ");
}

function PreferenceValue({
  title,
  detail,
  value,
}: {
  title: string;
  detail: string;
  value: React.ReactNode;
}) {
  return (
    <PreferenceRow title={title} detail={detail}>
      <span className="preference-static">{value}</span>
    </PreferenceRow>
  );
}

function Dropdown({
  options,
  selectedValue,
  onSelect,
  label,
  disabled = false,
  compact = false,
  searchable = false,
}: {
  options: Array<{ value: string; label: string }>;
  selectedValue: string;
  onSelect: (value: string) => void;
  label: string;
  disabled?: boolean;
  compact?: boolean;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === selectedValue);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className={`settings-dropdown ${compact ? "compact" : ""}`} ref={ref}>
      <button
        type="button"
        className="dropdown-control"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {compact && <i className="footer-dot" />}
        <span>{selected?.label ?? "Select an option…"}</span>
        <ChevronDown width={15} height={15} />
      </button>
      {open && !disabled && (
        <div className="dropdown-menu" role="listbox" aria-label={label}>
          {searchable && (
            <input
              className="dropdown-search"
              value={query}
              placeholder="Search languages…"
              aria-label="Search languages"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
              }}
              autoFocus
            />
          )}
          {options
            .filter((option) =>
              option.label.toLowerCase().includes(query.toLowerCase()),
            )
            .map((option) => (
              <button
                type="button"
                role="option"
                aria-selected={option.value === selectedValue}
                className={option.value === selectedValue ? "selected" : ""}
                key={`${option.value}-${option.label}`}
                onClick={() => {
                  onSelect(option.value);
                  setOpen(false);
                  setQuery("");
                }}
              >
                {option.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

function AppFooter({
  settings,
  version,
  saving,
  onSave,
}: {
  settings: AppSettings | null;
  version: string;
  saving: boolean;
  onSave: (patch: Partial<AppSettings>) => Promise<boolean>;
}) {
  return (
    <footer className="app-footer">
      {settings ? (
        <Dropdown
          compact
          label="Reasoning model"
          options={
            settings.recommendationProvider === "claude"
              ? claudeModelOptions
              : codexModelOptions
          }
          selectedValue={
            settings.recommendationProvider === "claude"
              ? settings.claudeModel
              : settings.codexModel
          }
          disabled={saving}
          onSelect={(value) =>
            void onSave(
              settings.recommendationProvider === "claude"
                ? { claudeModel: value as AppSettings["claudeModel"] }
                : { codexModel: value as AppSettings["codexModel"] },
            )
          }
        />
      ) : (
        <span className="model-state">
          <i /> Codex
        </span>
      )}
      <span className="footer-update">
        <button type="button" onClick={() => void checkForUpdates()}>
          Check for updates
        </button>
        <span>•</span>
        <span>v{version}</span>
      </span>
    </footer>
  );
}

function LoadingState() {
  return (
    <div className="loading-state" aria-label="Loading">
      <span />
      <span />
      <span />
    </div>
  );
}

function initials(value: string) {
  return value
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export default App;
