import { openUrl } from "@tauri-apps/plugin-opener";
import { transcriptionModels } from "./lib/transcriptionModels";
import { invoke } from "@tauri-apps/api/core";
import ManagedAccount from "./ManagedAccount";
import AudioCheck from "./AudioCheck";
import {
  managedSignInBegin,
  managedSignInFinish,
  managedSignInCancel,
} from "./lib/api";
import { getAppSettings, updateAppSettings } from "./lib/api";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Check, FileText, Mic, MonitorPlay, X } from "lucide-react";
import {
  getAppStatus,
  getTranscriptionKeyStatus,
  reopenApp,
  probeSystemAudioPermission,
  setTranscriptionApiKey,
  getRecommendationProviderStatus,
} from "./lib/api";
import type { ProviderHealth, TranscriptionKeyStatus } from "./types";

type Step =
  | "permissions"
  | "path"
  | "managed"
  | "transcription"
  | "ai"
  | "waiting"
  | "check";

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

/** Returns null when permission status cannot be read. */
async function readPermissions(
  probeCapture = false,
): Promise<PermissionReading | null> {
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
    if (probeCapture && !capture) {
      try {
        await probeSystemAudioPermission();
        return { macos: true, mic, capture: true };
      } catch {
        // A failed capture probe must not erase the microphone result.
      }
    }
    return { macos: true, mic, capture };
  } catch {
    return null;
  }
}

/** First-run setup. Permission repair for existing installs happens at meeting start. */
export default function Onboarding({ onComplete }: { onComplete: () => void }) {
  const signInGeneration = useRef(0);
  useEffect(
    () => () => {
      signInGeneration.current += 1;
      void managedSignInCancel().catch(() => undefined);
    },
    [],
  );
  const [step, setStep] = useState<Step>("path");
  const [isMacos, setIsMacos] = useState(false);
  const [microphone, setMicrophone] = useState<PermissionStatus>("checking");
  const [screen, setScreen] = useState<PermissionStatus>("checking");
  const [provider, setProvider] = useState<ProviderId>("deepgram");
  const [apiKey, setApiKey] = useState("");
  const [checkedProvider, setCheckedProvider] = useState<ProviderId | null>(
    null,
  );
  const [keyStatus, setKeyStatus] = useState<TranscriptionKeyStatus>({
    deepgram: false,
    assemblyAi: false,
  });
  const [microphoneOnly, setMicrophoneOnly] = useState(false);
  const [managed, setManaged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [keyCheckPending, setKeyCheckPending] = useState(false);
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
    if (!applyPermissions(await readPermissions(true))) reportCheckFailure();
  }, [applyPermissions, reportCheckFailure]);

  useEffect(() => {
    if (step !== "permissions") return;
    void readPermissions().then((reading) => {
      if (!applyPermissions(reading)) reportCheckFailure();
    });
  }, [applyPermissions, reportCheckFailure, step]);

  const settled = microphone === "granted" && screen === "granted";

  // Watch for permission changes made in System Settings while setup stays open.
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
    void getTranscriptionKeyStatus()
      .then(setKeyStatus)
      .catch(() => undefined);
  }, []);

  async function grantMicrophone() {
    setError(null);
    setMicrophone("waiting");
    try {
      const { requestMicrophonePermission } = await macosPermissions();
      await requestMicrophonePermission();
      // The request returns before the dialog is answered; polling picks up a later grant.
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
      if ((await readPermissions(true))?.capture) setScreen("granted");
    } catch {
      setScreen("needed");
      setError("Savvy could not request screen recording access. Try again.");
    }
  }

  async function configureTranscriptionProvider() {
    const settings = await getAppSettings();
    if (settings.transcriptionProvider === provider) return;
    const model = transcriptionModels[provider][0];
    await updateAppSettings({
      ...settings,
      transcriptionProvider: provider,
      transcriptionModel: model.value,
      transcriptionLanguage: model.languages[0],
    });
  }

  async function continueTranscriptionSetup() {
    setBusy(true);
    setError(null);
    try {
      if (keyStatus[provider]) await configureTranscriptionProvider();
      setStep("ai");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function saveKey() {
    if (!apiKey.trim()) return;
    setBusy(true);
    setKeyCheckPending(true);
    setError(null);
    try {
      const status = await setTranscriptionApiKey(provider, apiKey.trim());
      setApiKey("");
      await configureTranscriptionProvider();
      setKeyStatus(status);
      setCheckedProvider(provider);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setKeyCheckPending(false);
    }
  }

  async function reopen() {
    setBusy(true);
    setError(null);
    try {
      await reopenApp();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function choosePersonalProviders() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const settings = await getAppSettings();
      setProvider(settings.transcriptionProvider);
      setManaged(false);
      setStep("transcription");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  const hasSelectedKey = keyStatus[provider];

  if (step === "permissions") {
    return (
      <OnboardingShell subtitle="To get started, let Savvy hear the meeting.">
        {managed && (
          <p>
            When transcription starts, audio passes through Savvy to Deepgram
            and uses your managed allowance. Permission alone does not start
            transcription.
          </p>
        )}
        {isMacos && (
          <div className="onboarding-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void invoke("open_audio_settings", { system: false }).catch(
                  (reason) => setError(String(reason)),
                )
              }
            >
              Microphone settings
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void invoke("open_audio_settings", { system: true }).catch(
                  (reason) => setError(String(reason)),
                )
              }
            >
              System audio settings
            </button>
          </div>
        )}
        <PermissionRow
          icon={Mic}
          title="Microphone"
          detail="Transcribes your side of the meeting."
          status={microphone}
          onGrant={grantMicrophone}
          disabled={!isMacos || busy}
        />
        <PermissionRow
          icon={MonitorPlay}
          title="Screen &amp; system audio"
          detail="Transcribes everyone else in an online meeting."
          status={screen}
          onGrant={grantScreenRecording}
          disabled={!isMacos || busy}
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
        {(microphone === "waiting" || screen === "waiting") && (
          <p className="onboarding-note">
            Already allowed in System Settings? macOS may need a fresh launch to
            recognize the change.
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void reopen()}
            >
              Reopen Savvy
            </button>
          </p>
        )}
        <label>
          <input
            type="checkbox"
            disabled={busy}
            checked={microphoneOnly}
            onChange={(event) => setMicrophoneOnly(event.target.checked)}
          />{" "}
          Use microphone only
        </label>
        <ErrorNotice message={error} onDismiss={() => setError(null)} />
        <button
          className="button secondary"
          disabled={busy}
          onClick={onComplete}
        >
          Set up later
        </button>
        <div className="onboarding-actions">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void refreshPermissions()}
          >
            Check again
          </button>
          <button
            className="button"
            disabled={
              busy ||
              microphone !== "granted" ||
              (screen !== "granted" && !microphoneOnly)
            }
            onClick={() => {
              if (busy) return;
              setBusy(true);
              setError(null);
              void getAppSettings()
                .then((settings) =>
                  updateAppSettings({ ...settings, microphoneOnly }),
                )
                .then(() => setStep("check"))
                .catch((reason) => setError(String(reason)))
                .finally(() => setBusy(false));
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
            With microphone only, Savvy only hears you. Allow system audio or
            select Use microphone only to continue.
          </p>
        )}
      </OnboardingShell>
    );
  }

  async function signIn(createAccount: boolean) {
    if (busy) return;
    const generation = ++signInGeneration.current;
    setBusy(true);
    setError(null);
    setStep("waiting");
    try {
      const authorization = await managedSignInBegin(createAccount);
      if (generation !== signInGeneration.current) return;
      await managedSignInFinish(authorization);
      if (generation !== signInGeneration.current) return;
      const settings = await getAppSettings();
      if (generation !== signInGeneration.current) return;
      await updateAppSettings({ ...settings, serviceMode: "managed" });
      if (generation !== signInGeneration.current) return;
      setManaged(true);
      setStep("permissions");
    } catch (reason) {
      if (generation === signInGeneration.current) {
        setError(String(reason));
        setStep("path");
      }
    } finally {
      if (generation === signInGeneration.current) setBusy(false);
    }
  }
  if (step === "waiting")
    return (
      <OnboardingShell subtitle="Finish signing in">
        <p role="status">
          Continue in your browser. Savvy will verify your account before
          continuing.
        </p>
        <button
          className="button secondary"
          onClick={() =>
            void managedSignInCancel()
              .then(() => {
                signInGeneration.current += 1;
                setStep("path");
                setBusy(false);
              })
              .catch((reason) => setError(String(reason)))
          }
        >
          Cancel sign-in
        </button>
        <ErrorNotice message={error} onDismiss={() => setError(null)} />
      </OnboardingShell>
    );
  if (step === "check")
    return (
      <OnboardingShell subtitle="Audio setup" className="onboarding-audio">
        <AudioCheck
          configureInput
          managed={managed}
          microphoneOnly={microphoneOnly}
          onComplete={onComplete}
        />
      </OnboardingShell>
    );
  if (step === "ai")
    return (
      <PersonalAISetup
        onBack={() => setStep("transcription")}
        onContinue={(personal) => {
          setManaged(!personal);
          setStep("permissions");
        }}
      />
    );
  if (step === "path")
    return (
      <OnboardingShell
        subtitle="Welcome to Savvy"
        className="onboarding-welcome"
        footer="Your meeting history stays on this Mac."
      >
        <h2>Your next meeting, prepared.</h2>
        <p>Savvy handles transcription and AI setup.</p>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => void signIn(true)}
        >
          Create account
        </button>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void signIn(false)}
        >
          Sign in
        </button>
        <div className="onboarding-browser-note">
          <p>Opens your browser. No purchase required.</p>
          <button
            className="onboarding-pricing-link"
            disabled={busy}
            onClick={() => setStep("managed")}
          >
            View pricing
          </button>
        </div>
        <hr />
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void choosePersonalProviders()}
        >
          Use your own providers
        </button>
        <p>Connect your tools. No Savvy account needed.</p>
        <ErrorNotice message={error} onDismiss={() => setError(null)} />
      </OnboardingShell>
    );
  if (step === "managed")
    return (
      <OnboardingShell subtitle="Plans and pricing">
        <ManagedAccount pricingOnly />
        <div className="onboarding-actions">
          <button className="button" onClick={onComplete}>
            Explore Savvy
          </button>
          <button className="button secondary" onClick={() => setStep("path")}>
            Back to provider paths
          </button>
        </div>
      </OnboardingShell>
    );

  return (
    <OnboardingShell subtitle="Add a transcription key so Savvy can turn speech into text.">
      <div className="onboarding-providers">
        {PROVIDERS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`onboarding-provider ${provider === option.id ? "selected" : ""}`}
            aria-pressed={provider === option.id}
            disabled={busy}
            onClick={() => {
              if (provider === option.id) return;
              setApiKey("");
              setError(null);
              setProvider(option.id);
            }}
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
      <a
        href={PROVIDERS.find((option) => option.id === provider)?.keyUrl}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          if (!window.__TAURI_INTERNALS__) return;
          event.preventDefault();
          const url = PROVIDERS.find(
            (option) => option.id === provider,
          )!.keyUrl;
          void openUrl(url).catch(() =>
            setError("The provider console could not be opened. Try again."),
          );
        }}
      >
        Get your {PROVIDERS.find((option) => option.id === provider)?.label} API
        key
      </a>
      <p className="onboarding-note">
        <FileText /> Savvy checks the key directly with your provider before
        saving it in macOS Keychain. This does not capture or send audio.
      </p>
      {!window.__TAURI_INTERNALS__ && (
        <p className="onboarding-note">
          Browser demo: keys are simulated and are not sent to a provider.
        </p>
      )}
      {checkedProvider === provider && (
        <p className="onboarding-note" role="status">
          Key saved. Run the audio check to confirm transcription works.
        </p>
      )}
      <ErrorNotice message={error} onDismiss={() => setError(null)} />
      <div className="onboarding-actions">
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void continueTranscriptionSetup()}
        >
          {hasSelectedKey ? "Done" : "Skip for now"}
        </button>
        <button
          className="button"
          disabled={busy || !apiKey.trim()}
          onClick={() => void saveKey()}
        >
          {keyCheckPending ? "Checking key…" : "Save key"}
        </button>
      </div>
      {!hasSelectedKey && (
        <p className="onboarding-note">
          You can add this later under Models, but meetings cannot be
          transcribed until you do.
        </p>
      )}
    </OnboardingShell>
  );
}

function PersonalAISetup({
  onBack,
  onContinue,
}: {
  onBack: () => void;
  onContinue: (personal: boolean) => void;
}) {
  const [provider, setProvider] = useState<ProviderHealth["provider"] | null>(
    null,
  );
  const [health, setHealth] = useState<ProviderHealth[] | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([getAppSettings(), getRecommendationProviderStatus(true)])
      .then(([settings, status]) => {
        if (cancelled) return;
        setProvider((selected) => selected ?? settings.recommendationProvider);
        setHealth(status);
      })
      .catch((reason) => {
        if (cancelled) return;
        setHealth([]);
        setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  const selected = health?.find((entry) => entry.provider === provider);
  const ready = Boolean(selected?.available && selected.credentialPresent);
  async function continueSetup(skip = false) {
    if (saving || (!skip && (!provider || !ready))) return;
    setSaving(true);
    setError(null);
    try {
      let settings = await getAppSettings();
      if (!skip && provider) {
        settings = await updateAppSettings({
          ...settings,
          recommendationProvider: provider,
          serviceMode: "byok",
        });
      }
      onContinue(settings.serviceMode === "byok");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <OnboardingShell subtitle="Connect your AI">
      <p>
        Choose the account you use for meeting guidance. Savvy checks
        installation and sign-in on this Mac.
      </p>
      <div
        className="onboarding-providers"
        role="group"
        aria-label="AI provider"
      >
        {(["codex", "claude"] as const).map((id) => {
          const status = health?.find((entry) => entry.provider === id);
          return (
            <button
              key={id}
              className={`onboarding-provider ${provider === id ? "selected" : ""}`}
              aria-pressed={provider === id}
              disabled={saving}
              onClick={() => setProvider(id)}
            >
              <strong>{id === "codex" ? "Codex CLI" : "Claude Code"}</strong>
              <span>
                {health === null
                  ? "Checking…"
                  : (status?.message ?? "Status unavailable")}
              </span>
            </button>
          );
        })}
      </div>
      <p role="status">
        {health === null
          ? "Checking installation and sign-in…"
          : ready
            ? "Connected. Continue when you are ready."
            : !selected
              ? "Provider status is unavailable. Check again or finish setup later."
              : selected.available
                ? "Open your selected AI tool in Terminal and finish signing in, then check again."
                : "Install your selected AI tool and sign in, then reopen Savvy and check again."}
      </p>
      <ErrorNotice message={error} onDismiss={() => setError(null)} />
      <div className="onboarding-actions">
        <button className="button secondary" disabled={saving} onClick={onBack}>
          Back
        </button>
        <button
          className="button secondary"
          disabled={saving || health === null}
          onClick={() => {
            setHealth(null);
            setError(null);
            setAttempt((value) => value + 1);
          }}
        >
          Check again
        </button>
        <button
          className="button"
          disabled={saving || !ready}
          onClick={() => void continueSetup()}
        >
          Continue
        </button>
      </div>
      <button
        className="button secondary"
        disabled={saving}
        onClick={() => void continueSetup(true)}
      >
        Set up later
      </button>
      <p>
        Skipping keeps your current provider path and leaves AI readiness
        unverified. You can finish setup in Models.
      </p>
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
  className = "",
  footer,
}: {
  subtitle: string;
  children: React.ReactNode;
  className?: string;
  footer?: React.ReactNode;
}) {
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    title.current?.focus();
  }, [subtitle]);
  return (
    <div
      className={`onboarding ${className}`}
      role="dialog"
      aria-label="Set up Savvy"
      aria-describedby={titleId}
    >
      <div className="onboarding-header">
        <strong className="savvy-wordmark">savvy</strong>
        <h1 id={titleId} ref={title} tabIndex={-1}>
          {subtitle}
        </h1>
      </div>
      <div className="onboarding-card">{children}</div>
      {footer && <p className="onboarding-footer">{footer}</p>}
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
