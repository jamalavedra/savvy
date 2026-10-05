import { useEffect, useRef, useState } from "react";
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
    return "No signal detected. Check your input and try again.";
  };
  return (
    <section
      className={`settings-group ${configureInput ? "audio-setup-step" : ""}`}
      aria-label="Audio checks"
    >
      <h2 ref={heading} tabIndex={-1}>
        {!configureInput
          ? "Check your audio"
          : step === "microphone"
            ? "Check your microphone"
            : step === "system"
              ? "Check meeting audio"
              : "Check transcription"}
      </h2>
      {configureInput && step === "microphone" && (
        <div className="audio-input-setup">
          {!inputReady && !inputError && <p>Loading microphones…</p>}
          <label>
            Microphone
            <select
              value={input ?? ""}
              disabled={!inputReady || inputBusy || running}
              onChange={(event) =>
                void saveInput(event.target.value || null, null)
              }
            >
              <option value="">
                System default
                {inputs.find((device) => device.isDefault)?.name
                  ? ` (${inputs.find((device) => device.isDefault)?.name})`
                  : ""}
              </option>
              {input && !inputs.some((device) => device.name === input) && (
                <option value={input}>{input} (disconnected)</option>
              )}
              {inputs.map((device) => (
                <option key={device.name} value={device.name}>
                  {device.name}
                </option>
              ))}
            </select>
          </label>
          <details>
            <summary>Input options</summary>
            <p>
              If your preferred microphone is disconnected, capture uses the
              system default.
            </p>
            {(selectedDevice?.channels ?? 0) > 1 && (
              <label>
                Input channel
                <select
                  value={channel ?? ""}
                  disabled={!inputReady || inputBusy || running}
                  onChange={(event) =>
                    void saveInput(
                      input,
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                    )
                  }
                >
                  <option value="">Average all channels</option>
                  {Array.from(
                    { length: selectedDevice?.channels ?? 0 },
                    (_, index) => (
                      <option key={index} value={index}>
                        Channel {index + 1}
                      </option>
                    ),
                  )}
                </select>
              </label>
            )}
            <button
              className="button secondary"
              disabled={running || inputBusy}
              onClick={() => {
                resetCheck();
                setInputRefresh((value) => value + 1);
              }}
            >
              Refresh microphones
            </button>
          </details>
          {inputReady && inputs.length === 0 && (
            <p>No microphones found. Connect an input and refresh.</p>
          )}
          {inputBusy && <p>Saving input…</p>}
          {inputError && <p role="alert">{inputError}</p>}
        </div>
      )}
      {configureInput && step !== "transcription" ? (
        <p>
          {step === "microphone"
            ? "Speak naturally. The meter should move with your voice."
            : "Play meeting audio or another sound on your Mac. The meter should move."}{" "}
          Choose Check signal to start local capture. This does not test
          transcription.
        </p>
      ) : (
        <p>
          {!configureInput && "Signal checks use local capture. "}
          Transcription tests send audio to your selected provider for up to 30
          seconds.
          {managed && " This uses your managed meeting allowance."} Nothing
          starts until you choose a check.
        </p>
      )}
      {(!configureInput ||
        !connected ||
        step === "transcription" ||
        reading.status === "failed" ||
        reading.status === "starting") && (
        <p role="status">
          {reading.message ||
            (transcribing
              ? "Listening for a real transcript…"
              : "Speak to check your microphone. Play meeting audio to check system sound.")}
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
          <p>
            Transcription is working. No meeting starts until you choose Start.
          </p>
          {onComplete && (
            <button
              className="button"
              disabled={inputBusy}
              onClick={onComplete}
            >
              Finish setup
            </button>
          )}
        </>
      )}
      {!passed && (!configureInput || step === "transcription") && (
        <p>
          After starting the transcription test, say: I am ready for my meeting.
        </p>
      )}
      {!transcribing && (!configureInput || step !== "transcription") && (
        <>
          {(!configureInput || step === "microphone") && (
            <>
              <label>
                Microphone signal{" "}
                <meter min={0} max={1} value={reading.microphoneLevel} />
              </label>
              <p aria-live="polite" aria-label="Microphone signal status">
                {signalStatus(detected.microphone)}
              </p>
            </>
          )}
          {!microphoneOnly && (!configureInput || step === "system") && (
            <>
              <label>
                System audio signal{" "}
                <meter min={0} max={1} value={reading.systemLevel} />
              </label>
              <p aria-live="polite" aria-label="System audio signal status">
                {signalStatus(detected.system)}
              </p>
            </>
          )}
        </>
      )}
      <div className="onboarding-actions">
        {(!configureInput || step !== "transcription") && (
          <button
            className="button secondary"
            disabled={!connected || running || !inputReady || inputBusy}
            onClick={() => void start(false)}
          >
            Check signal
          </button>
        )}
        {configureInput && step !== "transcription" && (
          <button
            className="button"
            disabled={
              inputBusy ||
              reading.status === "failed" ||
              !(step === "microphone" ? detected.microphone : detected.system)
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
          </button>
        )}
        {(!configureInput || step === "transcription") && (
          <button
            className="button"
            disabled={!connected || running || !inputReady || inputBusy}
            onClick={() => void start(true)}
          >
            {passed ? "Test again" : "Start transcription test"}
          </button>
        )}
        {running && (
          <button className="button secondary" onClick={stopCheck}>
            Stop check
          </button>
        )}
      </div>
      {configureInput && step !== "microphone" && (
        <button
          className="button secondary"
          disabled={running || inputBusy}
          onClick={() => {
            setTranscribing(false);
            resetCheck();
            setStep("microphone");
          }}
        >
          Choose a different input
        </button>
      )}
      {!connected && reading.status === "failed" && (
        <button
          className="button secondary"
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
        </button>
      )}
      {connected &&
        reading.status === "failed" &&
        Boolean(window.__TAURI_INTERNALS__) && (
          <div className="onboarding-actions">
            {(microphoneOnly ? [false] : [false, true]).map((system) => (
              <button
                key={String(system)}
                className="button secondary"
                onClick={() =>
                  void invoke("open_audio_settings", { system }).catch(
                    (reason) =>
                      setReading((r) => ({ ...r, message: String(reason) })),
                  )
                }
              >
                {system
                  ? "Open meeting audio settings"
                  : "Open microphone settings"}
              </button>
            ))}
          </div>
        )}
      {configureInput && onComplete && (
        <>
          <button
            className="button secondary"
            disabled={inputBusy}
            onClick={onComplete}
          >
            Explore Savvy
          </button>
          <p>Skipping a check leaves audio readiness unverified.</p>
        </>
      )}
      {!window.__TAURI_INTERNALS__ && (
        <p>
          Real audio checks are available in the macOS app. This browser demo
          does not capture audio.
        </p>
      )}
    </section>
  );
}
