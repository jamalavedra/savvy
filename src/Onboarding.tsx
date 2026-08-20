import { useCallback, useEffect, useState } from "react";
import { Check, FileText, Mic, MonitorPlay, X } from "lucide-react";
import {
  getAppStatus,
  getTranscriptionKeyStatus,
  setTranscriptionApiKey,
} from "./lib/api";
import type { TranscriptionKeyStatus } from "./types";

type Step = "permissions" | "transcription";

type PermissionStatus = "checking" | "needed" | "waiting" | "granted";

const PROVIDERS = [
  { id: "deepgram", label: "Deepgram", keyUrl: "https://console.deepgram.com" },
  {
    id: "assemblyAi",
    label: "AssemblyAI",
    keyUrl: "https://www.assemblyai.com/app",
  },
] as const;

type ProviderId = (typeof PROVIDERS)[number]["id"];

const PERMISSION_POLL_MS = 1_000;
const MAX_CONSECUTIVE_CHECK_FAILURES = 3;
const CHECK_FAILED = "Savvy could not check its permissions. Try again.";

async function macosPermissions() {
  return import("tauri-plugin-macos-permissions-api");
}

type PermissionReading = { macos: boolean; mic: boolean; capture: boolean };

/**
 * Reads the current permission state. Returns rather than sets, so callers own the
 * state update — a reader that set state itself would be a synchronous setState
 * inside an effect. A failed read returns null. Guessing "denied" would show the
 * user buttons that cannot work, with nothing explaining why.
 */
async function readPermissions(): Promise<PermissionReading | null> {
  try {
    const status = await getAppStatus();
    if (status.platform !== "macos") {
      // Nothing to grant off macOS; report satisfied rather than showing controls
      // that cannot do anything.
      return { macos: false, mic: true, capture: true };
    }
    const { checkMicrophonePermission, checkScreenRecordingPermission } =
      await macosPermissions();
    const [mic, capture] = await Promise.all([
      checkMicrophonePermission(),
      checkScreenRecordingPermission(),
    ]);
    return { macos: true, mic, capture };
  } catch {
    return null;
  }
}

/**
 * First-run setup.
 *
 * `returningUser` restricts the flow to the permission step: someone who already
 * finished onboarding but has since revoked a permission needs to repair it, not to
 * be onboarded again.
 */
export default function Onboarding({
  returningUser,
  onComplete,
}: {
  returningUser: boolean;
  onComplete: () => void;
}) {
  const [step, setStep] = useState<Step>("permissions");
  const [isMacos, setIsMacos] = useState(false);
  const [microphone, setMicrophone] = useState<PermissionStatus>("checking");
  const [screen, setScreen] = useState<PermissionStatus>("checking");
  const [provider, setProvider] = useState<ProviderId>("deepgram");
  const [apiKey, setApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<TranscriptionKeyStatus>({
    deepgram: false,
    assemblyAi: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyPermissions = useCallback((reading: PermissionReading | null) => {
    if (!reading) return false;
    setIsMacos(reading.macos);
    setMicrophone(reading.mic ? "granted" : "needed");
    setScreen(reading.capture ? "granted" : "needed");
    return true;
  }, []);

  /** The rows would otherwise sit on "Checking…" forever with nothing explaining it. */
  const reportCheckFailure = useCallback(() => {
    setIsMacos(true);
    setMicrophone("needed");
    setScreen("needed");
    setError(CHECK_FAILED);
  }, []);

  const refreshPermissions = useCallback(async () => {
    setError(null);
    setMicrophone("checking");
    setScreen("checking");
    if (!applyPermissions(await readPermissions())) reportCheckFailure();
  }, [applyPermissions, reportCheckFailure]);

  useEffect(() => {
    void readPermissions().then((reading) => {
      if (!applyPermissions(reading)) reportCheckFailure();
    });
  }, [applyPermissions, reportCheckFailure]);

  const settled = microphone === "granted" && screen === "granted";

  // The user grants permissions in System Settings, outside this window, so the
  // answer arrives whenever they come back, not within any fixed wait. Watch for it.
  useEffect(() => {
    if (step !== "permissions" || !isMacos || settled) return;
    let failures = 0;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      const reading = await readPermissions();
      if (stopped) return;
      if (!reading) {
        failures += 1;
        if (failures < MAX_CONSECUTIVE_CHECK_FAILURES) return;
        stopped = true;
        window.clearInterval(timer);
        setError(CHECK_FAILED);
        return;
      }
      failures = 0;
      // Promote only. The user may be part way through granting in System
      // Settings, and a row must not snap back to "Allow" under them.
      if (reading.mic) setMicrophone("granted");
      if (reading.capture) setScreen("granted");
    };
    const timer = window.setInterval(() => void poll(), PERMISSION_POLL_MS);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [isMacos, settled, step]);

  useEffect(() => {
    if (returningUser) return;
    void getTranscriptionKeyStatus()
      .then(setKeyStatus)
      .catch(() => undefined);
  }, [returningUser]);

  async function grantMicrophone() {
    setError(null);
    setMicrophone("waiting");
    try {
      const { requestMicrophonePermission } = await macosPermissions();
      await requestMicrophonePermission();
      // The system dialog has closed; show the answer now instead of on the next poll.
      if ((await readPermissions())?.mic) setMicrophone("granted");
    } catch {
      setMicrophone("needed");
      setError("Savvy could not request microphone access. Try again.");
    }
  }

  async function grantScreenRecording() {
    setError(null);
    setScreen("waiting");
    try {
      const { requestScreenRecordingPermission } = await macosPermissions();
      await requestScreenRecordingPermission();
      if ((await readPermissions())?.capture) setScreen("granted");
    } catch {
      setScreen("needed");
      setError("Savvy could not request screen recording access. Try again.");
    }
  }

  async function saveKey() {
    if (!apiKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setKeyStatus(await setTranscriptionApiKey(provider, apiKey.trim()));
      setApiKey("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const hasAnyKey = keyStatus.deepgram || keyStatus.assemblyAi;

  if (step === "permissions") {
    return (
      <OnboardingShell
        subtitle={
          returningUser
            ? "Savvy needs its permissions back before the next meeting."
            : "To get started, let Savvy hear the meeting."
        }
      >
        <PermissionRow
          icon={Mic}
          title="Microphone"
          detail="Transcribes your side of the meeting."
          status={microphone}
          onGrant={grantMicrophone}
          disabled={!isMacos}
        />
        <PermissionRow
          icon={MonitorPlay}
          title="Screen &amp; system audio"
          detail="Transcribes everyone else in an online meeting."
          status={screen}
          onGrant={grantScreenRecording}
          disabled={!isMacos}
        />
        {microphone === "waiting" && (
          <p className="onboarding-note">
            Waiting for macOS. If no prompt appeared, allow Savvy under System
            Settings › Privacy &amp; Security › Microphone.
          </p>
        )}
        {screen === "waiting" && (
          <p className="onboarding-note">
            Waiting for macOS. Allow Savvy under System Settings › Privacy &amp;
            Security › Screen &amp; System Audio Recording. macOS may ask you to
            reopen Savvy.
          </p>
        )}
        <ErrorNotice message={error} onDismiss={() => setError(null)} />
        <div className="onboarding-actions">
          <button
            className="button secondary"
            onClick={() => void refreshPermissions()}
          >
            Check again
          </button>
          <button
            className="button"
            disabled={microphone !== "granted"}
            onClick={() => {
              setError(null);
              if (returningUser) onComplete();
              else setStep("transcription");
            }}
          >
            Continue
          </button>
        </div>
        {microphone !== "granted" && microphone !== "checking" && (
          <p className="onboarding-note">
            Savvy needs microphone access before you can continue.
          </p>
        )}
        {screen !== "granted" && microphone === "granted" && (
          <p className="onboarding-note">
            Without screen &amp; system audio, Savvy only hears you — not the
            people you are meeting.
          </p>
        )}
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell subtitle="Add a transcription key so Savvy can turn speech into text.">
      <div className="onboarding-providers">
        {PROVIDERS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`onboarding-provider ${provider === option.id ? "selected" : ""}`}
            aria-pressed={provider === option.id}
            onClick={() => setProvider(option.id)}
          >
            <strong>{option.label}</strong>
            {keyStatus[option.id] && (
              <span className="onboarding-status granted">
                <Check /> Key saved
              </span>
            )}
          </button>
        ))}
      </div>
      <label className="onboarding-field">
        <span>{PROVIDERS.find((o) => o.id === provider)?.label} API key</span>
        <input
          type="password"
          value={apiKey}
          disabled={busy}
          placeholder="Paste your API key"
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      <p className="onboarding-note">
        <FileText /> Stored in the macOS Keychain, never in settings or logs.
      </p>
      <ErrorNotice message={error} onDismiss={() => setError(null)} />
      <div className="onboarding-actions">
        <button
          className="button secondary"
          disabled={busy}
          onClick={onComplete}
        >
          {hasAnyKey ? "Done" : "Skip for now"}
        </button>
        <button
          className="button"
          disabled={busy || !apiKey.trim()}
          onClick={() => void saveKey()}
        >
          Save key
        </button>
      </div>
      {!hasAnyKey && (
        <p className="onboarding-note">
          You can add this later under Models, but meetings cannot be
          transcribed until you do.
        </p>
      )}
    </OnboardingShell>
  );
}

/** Shows a setup error the user can dismiss, matching the workspace error banner. */
function ErrorNotice({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) {
  if (!message) return null;
  return (
    <p className="onboarding-error" role="alert">
      <span>{message}</span>
      <button
        type="button"
        aria-label="Dismiss alert"
        title="Dismiss"
        onClick={onDismiss}
      >
        <X />
      </button>
    </p>
  );
}

function OnboardingShell({
  subtitle,
  children,
}: {
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="onboarding" role="dialog" aria-label="Set up Savvy">
      <div className="onboarding-header">
        <strong className="savvy-wordmark">savvy</strong>
        <p>{subtitle}</p>
      </div>
      <div className="onboarding-card">{children}</div>
    </div>
  );
}

function PermissionRow({
  icon: Icon,
  title,
  detail,
  status,
  disabled,
  onGrant,
}: {
  icon: typeof Mic;
  title: string;
  detail: string;
  status: PermissionStatus;
  disabled: boolean;
  onGrant: () => Promise<void>;
}) {
  return (
    <div className="onboarding-row">
      <span className="onboarding-icon">
        <Icon />
      </span>
      <span className="setting-copy">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      {status === "granted" ? (
        <span className="onboarding-status granted">
          <Check /> Allowed
        </span>
      ) : status === "checking" || status === "waiting" ? (
        <span className="onboarding-status">
          {status === "checking" ? "Checking…" : "Waiting…"}
        </span>
      ) : (
        <button
          className="button secondary"
          disabled={disabled}
          onClick={() => void onGrant()}
        >
          Allow
        </button>
      )}
    </div>
  );
}
