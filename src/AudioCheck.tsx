import { Alert, Button, Select } from "./ui";
import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getAppSettings, getInputDevices, updateAppSettings } from "./lib/api";
import type { AudioDevice } from "./types";

type CheckStatus =
  | "idle"
  | "starting"
  | "listening"
  | "passed"
  | "failed"
  | "finished"
  | "cancelled";
type CheckEvent = {
  id: string;
  status: CheckStatus;
  microphoneLevel: number;
  systemLevel: number;
  message: string;
  transcript?: string | null;
};
export default function AudioCheck({
  managed,
  microphoneOnly,
  onComplete,
  configureInput = false,
}: {
  managed: boolean;
  microphoneOnly: boolean;
  onComplete?: () => void;
  configureInput?: boolean;
}) {
  const [step, setStep] = useState<"microphone" | "system" | "transcription">(
    "microphone",
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const meterId = useId();
  useEffect(() => {
    if (configureInput) heading.current?.focus();
  }, [configureInput, step]);
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [input, setInput] = useState<string | null>(null);
  const [channel, setChannel] = useState<number | null>(null);
  const [inputReady, setInputReady] = useState(!configureInput);
  const [inputBusy, setInputBusy] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [inputRefresh, setInputRefresh] = useState(0);
  const inputPending = useRef(false);
  useEffect(() => {
    if (!configureInput) return;
    let cancelled = false;
    setInputReady(false);
    setInputError(null);
    Promise.all([getInputDevices(), getAppSettings()])
      .then(([devices, settings]) => {
        if (cancelled) return;
        setInputs(devices);
        setInput(settings.selectedMicrophone);
        setChannel(settings.selectedChannel);
        setInputReady(true);
      })
      .catch((reason) => {
        if (!cancelled) setInputError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [configureInput, inputRefresh]);
  const [reading, setReading] = useState<CheckEvent>({
    id: "",
    status: "idle",
    microphoneLevel: 0,
    systemLevel: 0,
    message: "Audio has not been checked.",
  });
  const [detected, setDetected] = useState({
    microphone: false,
    system: false,
  });
  const [connected, setConnected] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const active = useRef<string | null>(null);
  const unmounted = useRef(false);
  const cancellation = useRef({ requested: false });
  useEffect(() => {
    let disposed = false;
    unmounted.current = false;
    setConnected(false);
    const subscription = listen<CheckEvent>(
      "audio-check://status",
      ({ payload }) => {
        if (!disposed && payload.id === active.current) {
          setReading(payload);
          if (payload.status === "listening") {
            setDetected((previous) => ({
              microphone:
                previous.microphone ||
                (Number.isFinite(payload.microphoneLevel) &&
                  payload.microphoneLevel > 0),
              system:
                previous.system ||
                (Number.isFinite(payload.systemLevel) &&
                  payload.systemLevel > 0),
            }));
          }
          if (payload.status !== "listening" && payload.status !== "starting")
            active.current = null;
        }
      },
    )
      .then((unlisten) => {
        if (!disposed) {
          setConnected(true);
          setReading((r) => ({
            ...r,
            status: "idle",
            message: "Audio has not been checked.",
          }));
        }
        return unlisten;
      })
      .catch((reason) => {
        if (!disposed)
          setReading((r) => ({
            ...r,
            status: "failed",
            message: `Could not connect to audio checks: ${String(reason)}`,
          }));
      });
    return () => {
      disposed = true;
      unmounted.current = true;
      cancellation.current.requested = true;
      void subscription.then((unlisten) => unlisten?.());
      if (active.current)
        void invoke("audio_check_stop", { id: active.current }).catch(
          () => undefined,
        );
    };
  }, [connectionAttempt]);
  function resetCheck() {
    setDetected({ microphone: false, system: false });
    setReading({
      id: "",
      status: "idle",
      microphoneLevel: 0,
      systemLevel: 0,
      message: "Input changed. Run a new audio check.",
    });
    setTranscribing(false);
  }
  async function saveInput(
    selectedMicrophone: string | null,
    selectedChannel: number | null,
  ) {
    if (active.current || inputPending.current || !inputReady) return;
    inputPending.current = true;
    setInputBusy(true);
    setInputError(null);
    try {
      const settings = await getAppSettings();
      if (unmounted.current) return;
      const saved = await updateAppSettings({
        ...settings,
        selectedMicrophone,
        selectedChannel,
      });
      if (unmounted.current) return;
      setInput(saved.selectedMicrophone);
      setChannel(saved.selectedChannel);
      resetCheck();
    } catch (reason) {
      if (!unmounted.current) setInputError(String(reason));
    } finally {
      inputPending.current = false;
      if (!unmounted.current) setInputBusy(false);
    }
  }
  async function start(transcribe: boolean) {
    if (active.current || inputPending.current || !inputReady) return;
    const stop = { requested: false };
    cancellation.current = stop;
    const id = crypto.randomUUID();
    active.current = id;
    setTranscribing(transcribe);
    setDetected({ microphone: false, system: false });
    setReading({
      id,
      status: "starting",
      microphoneLevel: 0,
      systemLevel: 0,
      message: "Starting audio check…",
    });
    try {
      await invoke<string>("audio_check_start", { id, transcribe });
      if (stop.requested) await invoke("audio_check_stop", { id });
    } catch (reason) {
      if (active.current !== id || unmounted.current) return;
      active.current = null;
      setReading((r) => ({ ...r, status: "failed", message: String(reason) }));
    }
  }
  function stopCheck() {
    cancellation.current.requested = true;
    const id = active.current;
    if (id)
      void invoke("audio_check_stop", { id }).catch((reason) => {
        if (active.current === id)
          setReading((r) => ({ ...r, message: String(reason) }));
      });
  }
  const passed =
    reading.status === "passed" && Boolean(reading.transcript?.trim());
  const running =
    reading.status === "starting" || reading.status === "listening";
  const selectedDevice =
    inputs.find((device) =>
      input ? device.name === input : device.isDefault,
    ) ?? inputs.find((device) => device.isDefault);
  const signalStatus = (hasSignal: boolean) => {
    if (hasSignal) return "Input detected. This does not test transcription.";
    if (reading.status === "idle") return "Not checked.";
    if (running) return "No signal detected yet.";
    return "No signal detected. Check your input and permissions in System Settings, then quit and reopen Savvy.";
  };
  function signalRow(
    source: "microphone" | "system",
    label: string,
    level: number,
  ) {
    const hasSignal = detected[source];
    const state = hasSignal
      ? "detected"
      : reading.status === "idle"
        ? "idle"
        : running
          ? "waiting"
          : "missing";
    const status = hasSignal
      ? "Input detected"
      : state === "idle"
        ? "Not checked"
        : state === "waiting"
          ? "Waiting for signal"
          : "No signal detected";
    return (
      <div className="audio-signal-row">
        <div className="audio-signal-heading">
          <label htmlFor={`${meterId}-${source}`}>{label} signal</label>
          <p
            className="audio-signal-status"
            data-state={state}
            aria-live="polite"
            aria-label={`${label} signal status`}
          >
            <span aria-hidden="true">{status}</span>
            <span className="sr-only">{signalStatus(hasSignal)}</span>
          </p>
        </div>
        <meter
          id={`${meterId}-${source}`}
          className="audio-signal-meter"
          min={0}
          max={1}
          value={Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0}
        />
      </div>
    );
  }
  return (
    <section
      className={`settings-group audio-check ${configureInput ? "audio-setup-step" : ""}`}
      aria-label="Audio checks"
    >
      <h2
        ref={heading}
        tabIndex={-1}
        className={configureInput ? undefined : "group-title"}
      >
        {!configureInput
          ? "Check your audio"
          : step === "microphone"
            ? "Check your microphone"
            : step === "system"
              ? "Check meeting audio"
              : "Check transcription"}
      </h2>
      <div className="group-card audio-check-card">
        {configureInput && step === "microphone" && (
          <div className="audio-input-setup">
            {!inputReady && !inputError && <p>Loading microphones…</p>}
            <label>
              Microphone
              <Select
                label="Microphone"
                selectedValue={input ?? ""}
                disabled={!inputReady || inputBusy || running}
                options={[
                  {
                    value: "",
                    label: `System default${inputs.find((device) => device.isDefault)?.name ? ` (${inputs.find((device) => device.isDefault)?.name})` : ""}`,
                  },
                  ...(input && !inputs.some((device) => device.name === input)
                    ? [{ value: input, label: `${input} (disconnected)` }]
                    : []),
                  ...inputs.map((device) => ({
                    value: device.name,
                    label: device.name,
                  })),
                ]}
                onSelect={(value) => void saveInput(value || null, null)}
              />
            </label>
            <details className="ui-disclosure">
              <summary>Input options</summary>
              <p>
                If your preferred microphone is disconnected, capture uses the
                system default.
              </p>
              {(selectedDevice?.channels ?? 0) > 1 && (
                <label>
                  Input channel
                  <Select
                    label="Input channel"
                    selectedValue={channel == null ? "" : String(channel)}
                    disabled={!inputReady || inputBusy || running}
                    options={[
                      { value: "", label: "Average all channels" },
                      ...Array.from(
                        { length: selectedDevice?.channels ?? 0 },
                        (_, index) => ({
                          value: String(index),
                          label: `Channel ${index + 1}`,
                        }),
                      ),
                    ]}
                    onSelect={(value) =>
                      void saveInput(input, value === "" ? null : Number(value))
                    }
                  />
                </label>
              )}
              <Button
                disabled={running || inputBusy}
                onClick={() => {
                  resetCheck();
                  setInputRefresh((value) => value + 1);
                }}
              >
                Refresh microphones
              </Button>
            </details>
            {inputReady && inputs.length === 0 && (
              <p>No microphones found. Connect an input and refresh.</p>
            )}
            {inputBusy && <p>Saving input…</p>}
            {inputError && <Alert role="alert">{inputError}</Alert>}
          </div>
        )}

        {(!configureInput || step !== "transcription") && (
          <div className="audio-check-section">
            <div className="audio-check-section-heading">
              <h3>Local signal</h3>
              <span className="audio-check-meta">On this device</span>
            </div>
            <p className="audio-check-description">
              Audio stays on this device. Signal alone does not verify
              transcription.
            </p>
            {!transcribing && (
              <div className="audio-signal-list">
                {(!configureInput || step === "microphone") &&
                  signalRow(
                    "microphone",
                    "Microphone",
                    reading.microphoneLevel,
                  )}
                {!microphoneOnly &&
                  (!configureInput || step === "system") &&
                  signalRow("system", "System audio", reading.systemLevel)}
              </div>
            )}
            {running && !transcribing && (
              <p className="audio-check-instruction">
                {configureInput && step === "system"
                  ? "Play meeting audio or another sound. The system audio meter should move."
                  : microphoneOnly || configureInput
                    ? "Speak naturally. The microphone meter should move with your voice."
                    : "Speak naturally, then play meeting audio. Both meters should move."}
              </p>
            )}
            <div className="audio-check-actions">
              <Button
                variant={configureInput ? "secondary" : "primary"}
                disabled={!connected || running || !inputReady || inputBusy}
                onClick={() => void start(false)}
              >
                Check signal
              </Button>
              {configureInput && (
                <Button
                  variant="primary"
                  disabled={
                    inputBusy ||
                    reading.status === "failed" ||
                    !(step === "microphone"
                      ? detected.microphone
                      : detected.system)
                  }
                  onClick={() => {
                    const next =
                      step === "microphone" && !microphoneOnly
                        ? "system"
                        : "transcription";
                    if (next === "transcription") stopCheck();
                    setStep(next);
                  }}
                >
                  Continue
                </Button>
              )}
              {running && !transcribing && (
                <Button onClick={stopCheck}>Stop check</Button>
              )}
            </div>
          </div>
        )}
        {(!configureInput || step === "transcription") && (
          <div className="audio-check-section">
            <div className="audio-check-section-heading">
              <h3>Provider transcription</h3>
              <span className="audio-check-meta">Up to 30 seconds</span>
            </div>
            <p className="audio-check-description">
              This sends audio to your selected provider.
              {managed && " This uses your managed meeting allowance."} Nothing
              starts until you choose the test.
            </p>
            {running && transcribing && (
              <p className="audio-check-instruction">
                Say: I am ready for my meeting.
              </p>
            )}
            {passed && (
              <>
                <div
                  className="audio-test-transcript"
                  role="region"
                  aria-label="Test transcript"
                >
                  <h3>Test transcript</h3>
                  <p>{reading.transcript}</p>
                </div>
                <p className="audio-check-description">
                  Transcription is working. No meeting starts until you choose
                  Start.
                </p>
              </>
            )}
            <div className="audio-check-actions">
              {passed && onComplete && (
                <Button
                  variant="primary"
                  disabled={inputBusy}
                  onClick={onComplete}
                >
                  Finish setup
                </Button>
              )}
              <Button
                variant={configureInput && !passed ? "primary" : "secondary"}
                disabled={!connected || running || !inputReady || inputBusy}
                onClick={() => void start(true)}
              >
                {passed ? "Test again" : "Start transcription test"}
              </Button>
              {running && transcribing && (
                <Button onClick={stopCheck}>Stop check</Button>
              )}
            </div>
          </div>
        )}
        {(!configureInput ||
          !connected ||
          step === "transcription" ||
          reading.status === "failed" ||
          reading.status === "starting") && (
          <Alert
            className="audio-check-result"
            data-state={reading.status}
            variant={reading.status === "failed" ? "error" : "info"}
            role="status"
          >
            {reading.message ||
              (transcribing
                ? "Listening for a real transcript…"
                : running
                  ? "Local signal check running."
                  : "Audio has not been checked.")}
          </Alert>
        )}
        {configureInput && step !== "microphone" && (
          <Button
            variant="ghost"
            disabled={running || inputBusy}
            onClick={() => {
              setTranscribing(false);
              resetCheck();
              setStep("microphone");
            }}
          >
            Choose a different input
          </Button>
        )}
        {!connected && reading.status === "failed" && (
          <Button
            onClick={() => {
              setReading((r) => ({
                ...r,
                status: "idle",
                message: "Connecting audio checks…",
              }));
              setConnectionAttempt((value) => value + 1);
            }}
          >
            Reconnect audio checks
          </Button>
        )}
        {connected &&
          (reading.status === "failed" ||
            (reading.status === "finished" &&
              (!detected.microphone ||
                (!microphoneOnly && !detected.system)))) &&
          Boolean(window.__TAURI_INTERNALS__) && (
            <div className="audio-check-recovery">
              <p className="audio-check-description">
                Check your input and permissions in System Settings, then quit
                and reopen Savvy.
              </p>
              <div className="audio-check-actions">
                {(microphoneOnly ? [false] : [false, true]).map((system) => (
                  <Button
                    key={String(system)}
                    onClick={() =>
                      void invoke("open_audio_settings", { system }).catch(
                        (reason) =>
                          setReading((r) => ({
                            ...r,
                            message: String(reason),
                          })),
                      )
                    }
                  >
                    {system
                      ? "Open meeting audio settings"
                      : "Open microphone settings"}
                  </Button>
                ))}
              </div>
            </div>
          )}
        {configureInput && onComplete && !passed && (
          <div className="audio-check-skip">
            <Button variant="ghost" disabled={inputBusy} onClick={onComplete}>
              Explore Savvy
            </Button>
            <small>Skipping a check leaves audio readiness unverified.</small>
          </div>
        )}
        {!window.__TAURI_INTERNALS__ && (
          <p className="audio-check-description audio-check-demo">
            Real audio checks are available in the desktop app. This browser
            demo does not capture audio.
          </p>
        )}
      </div>
    </section>
  );
}
