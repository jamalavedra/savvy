import { useEffect, useRef, useState } from "react";
import AudioCheck from "./AudioCheck";
import {
  getAppStatus,
  getRecommendationProviderStatus,
  getTranscriptionKeyStatus,
  managedAccount,
} from "./lib/api";
import type { AppSettings } from "./types";

type Reading = {
  microphone: string;
  system: string;
  transcription: string;
  assistance: string;
  allowance: number | null;
  eligible: boolean;
  assistanceAvailable: boolean;
};

export default function MeetingReadiness({
  settings,
  clientName,
  busy,
  onBack,
  onStart,
  onConfigure,
}: {
  settings: AppSettings;
  clientName: string;
  busy: boolean;
  onBack: () => void;
  onStart: () => void;
  onConfigure: () => void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [audioOpen, setAudioOpen] = useState(false);
  const [allowUnavailableAI, setAllowUnavailableAI] = useState(false);
  const native = Boolean(window.__TAURI_INTERNALS__);
  const managed = settings.serviceMode === "managed";
  useEffect(() => title.current?.focus(), []);
  useEffect(() => {
    let disposed = false;
    async function check() {
      setReading(null);
      setError(null);
      setAllowUnavailableAI(false);
      if (!native) {
        setReading({
          microphone: "Not checked",
          system: "Not checked",
          transcription: "Synthetic demo",
          assistance: "Synthetic demo",
          allowance: null,
          eligible: true,
          assistanceAvailable: true,
        });
        return;
      }
      try {
        const result: Reading = {
          microphone: "Not checked",
          system: "Not checked",
          transcription: "Not checked",
          assistance: "Not checked",
          allowance: null,
          eligible: true,
          assistanceAvailable: true,
        };
        if ((await getAppStatus()).platform === "macos") {
          const { checkMicrophonePermission, checkScreenRecordingPermission } =
            await import("tauri-plugin-macos-permissions-api");
          const [mic, system] = await Promise.all([
            checkMicrophonePermission(),
            settings.microphoneOnly
              ? Promise.resolve(false)
              : checkScreenRecordingPermission(),
          ]);
          result.microphone = mic
            ? "Permission granted"
            : "Permission required";
          result.system = system ? "Permission granted" : "Permission required";
        }
        if (managed) {
          const account = await managedAccount();
          if (!account)
            throw new Error("Sign in to Savvy to check your allowance.");
          result.allowance = account.meetingMsAvailable;
          result.eligible = account.meetingMsAvailable > 0;
          result.transcription = result.eligible
            ? "Allowance available"
            : "No allowance";
          result.assistance = "Savvy assistance selected";
        } else {
          const [keys, provider] = await Promise.all([
            getTranscriptionKeyStatus(),
            getRecommendationProviderStatus(),
          ]);
          result.eligible = keys[settings.transcriptionProvider];
          result.transcription = result.eligible
            ? "API key configured"
            : "API key required";
          result.assistanceAvailable = Boolean(
            provider.find(
              (item) => item.provider === settings.recommendationProvider,
            )?.available,
          );
          result.assistance = result.assistanceAvailable
            ? "Provider available"
            : "Provider unavailable";
        }
        if (!disposed) setReading(result);
      } catch (reason) {
        if (!disposed)
          setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
    void check();
    return () => {
      disposed = true;
    };
  }, [
    native,
    managed,
    settings.microphoneOnly,
    settings.transcriptionProvider,
    settings.recommendationProvider,
    revision,
  ]);

  const pending = error ? "Not verified" : "Checking…";
  return (
    <div className="page-content prepare-page meeting-readiness">
      <div className="page-title">
        <h1 tabIndex={-1} ref={title}>
          {clientName}
        </h1>
        <p>{managed ? "Savvy assistance" : "Your own providers"}</p>
      </div>
      <h2 className="group-title">Before you start</h2>
      <dl className="prepare-card readiness-checks" aria-live="polite">
        <div>
          <dt>Microphone</dt>
          <dd>{reading?.microphone ?? pending}</dd>
        </div>
        <div>
          <dt>Meeting audio</dt>
          <dd>
            {settings.microphoneOnly
              ? "Microphone only"
              : (reading?.system ?? pending)}
          </dd>
        </div>
        <div>
          <dt>Transcription</dt>
          <dd>{reading?.transcription ?? pending}</dd>
        </div>
        <div>
          <dt>AI assistance</dt>
          <dd>{reading?.assistance ?? pending}</dd>
        </div>
      </dl>
      {error && <p role="alert">Could not check readiness: {error}</p>}
      <p>
        {reading?.allowance != null &&
          `${Math.floor(reading.allowance / 60000)} minutes available. `}
        {native ? (
          <>
            Permissions do not confirm signal or transcription. Use Check audio
            to test. While listening, audio goes to{" "}
            {managed
              ? "Savvy's transcription service"
              : "your selected transcription provider"}
            .
            {managed
              ? " Start meeting first checks your brief and selected context with Savvy's AI supplier, without using allowance."
              : " Press Start meeting to begin listening."}
          </>
        ) : (
          "This browser demo does not capture audio or connect to real providers."
        )}
      </p>
      <div className="onboarding-actions">
        <button
          className="button secondary"
          disabled={busy || audioOpen}
          onClick={() => setRevision((value) => value + 1)}
        >
          Recheck
        </button>
        <button
          className="button secondary"
          disabled={busy || audioOpen}
          onClick={onConfigure}
        >
          Account and providers
        </button>
        {native && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => setAudioOpen((value) => !value)}
          >
            {audioOpen ? "Close audio check" : "Check audio"}
          </button>
        )}
      </div>
      {reading && !reading.assistanceAvailable && (
        <label>
          <input
            type="checkbox"
            checked={allowUnavailableAI}
            disabled={busy}
            onChange={(event) => setAllowUnavailableAI(event.target.checked)}
          />{" "}
          Start with AI assistance unavailable.
        </label>
      )}
      {audioOpen && (
        <AudioCheck
          managed={managed}
          microphoneOnly={settings.microphoneOnly}
        />
      )}
      <div className="onboarding-actions readiness-actions">
        <button className="button secondary" disabled={busy} onClick={onBack}>
          Back
        </button>
        <button
          className="button primary"
          disabled={
            busy ||
            audioOpen ||
            !reading?.eligible ||
            (!reading.assistanceAvailable && !allowUnavailableAI)
          }
          onClick={onStart}
        >
          {busy ? "Starting…" : "Start meeting"}
        </button>
      </div>
    </div>
  );
}
