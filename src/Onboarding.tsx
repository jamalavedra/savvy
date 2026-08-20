import { useCallback, useEffect, useState } from "react";
import { Check, FileText, Mic, MonitorPlay } from "lucide-react";
import {
  getAppStatus,
  getTranscriptionKeyStatus,
  setTranscriptionApiKey,
} from "./lib/api";
import { requestPermissionDecision } from "./lib/permissions";
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

async function macosPermissions() {
  return import("tauri-plugin-macos-permissions-api");
}

type PermissionReading = { macos: boolean; mic: boolean; capture: boolean };

/**
 * Reads the current permission state. Returns rather than sets, so callers own the
 * state update — a reader that set state itself would be a synchronous setState
 * inside an effect.
 */
async function readPermissions(): Promise<PermissionReading> {
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
    // If the check itself fails, stop showing "Checking…" rather than trapping the
    // user on a step whose state can never resolve.
    return { macos: true, mic: false, capture: false };
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

  const applyPermissions = useCallback(
    ({ macos, mic, capture }: PermissionReading) => {
      setIsMacos(macos);
      setMicrophone(mic ? "granted" : "needed");
      setScreen(capture ? "granted" : "needed");
    },
    [],
  );

  const refreshPermissions = useCallback(async () => {
    setError(null);
    setMicrophone("checking");
    setScreen("checking");
    applyPermissions(await readPermissions());
  }, [applyPermissions]);

  useEffect(() => {
    void readPermissions().then(applyPermissions);
  }, [applyPermissions]);

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
      const { checkMicrophonePermission, requestMicrophonePermission } =
        await macosPermissions();
      const granted = await requestPermissionDecision(
        requestMicrophonePermission,
        checkMicrophonePermission,
      );
      setMicrophone(granted ? "granted" : "needed");
      if (granted) return;
      setError(
        "Allow Savvy microphone access in System Settings, then check again.",
      );
    } catch {
      setMicrophone("needed");
      setError("Savvy could not request microphone access. Try again.");
    }
  }

  async function grantScreenRecording() {
    setError(null);
    setScreen("waiting");
    try {
      const {
        checkScreenRecordingPermission,
        requestScreenRecordingPermission,
      } = await macosPermissions();
      const granted = await requestPermissionDecision(
        requestScreenRecordingPermission,
        checkScreenRecordingPermission,
      );
      setScreen(granted ? "granted" : "needed");
      if (granted) return;
      setError(
        "Allow Savvy screen recording in System Settings, then check again. macOS may ask you to reopen Savvy.",
      );
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
        {error && <p className="onboarding-error">{error}</p>}
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
            onClick={() =>
              returningUser ? onComplete() : setStep("transcription")
            }
          >
            Continue
          </button>
        </div>
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
              <span className="onboarding-granted">
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
      {error && <p className="onboarding-error">{error}</p>}
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
        <span className="onboarding-granted">
          <Check /> Allowed
        </span>
      ) : (
        <button
          className="button secondary"
          disabled={status === "checking" || status === "waiting" || disabled}
          onClick={() => void onGrant()}
        >
          {status === "checking"
            ? "Checking…"
            : status === "waiting"
              ? "Waiting…"
              : "Allow"}
        </button>
      )}
    </div>
  );
}
