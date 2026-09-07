import Image from "next/image";
import type { CSSProperties } from "react";

type Channel = "other" | "selfSpeaker";
export type Turn = { id: string; channel: Channel; text: string; interim?: boolean };
export type Status = "listening" | "checking" | "question" | "risk" | "manual";
type MascotState = "listening" | "thinking";

const STATUS_LABEL: Record<Status, string> = {
  listening: "Savvy is listening",
  checking: "Checking notes",
  question: "Answering their question",
  risk: "Checking a red line",
  manual: "Getting advice",
};

export const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function MicIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} {...iconProps} aria-hidden="true">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M2 2l20 20M18.89 13.23A7.12 7.12 0 0 0 19 12v-2M5 10v2a7 7 0 0 0 12 5" />
      <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33M9 9v3a3 3 0 0 0 5.12 2.12M12 19v3" />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4M22 5h-4M4 17v2M5 18H3" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <rect x="14" y="4" width="4" height="16" rx="1" />
      <rect x="6" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" />
    </svg>
  );
}

function Mascot({ state }: { state: MascotState }) {
  return (
    <Image
      className={`mascot-state ${state}`}
      src={`/images/mascot/savvy-${state}.png`}
      alt=""
      width={26}
      height={26}
      draggable={false}
    />
  );
}

export function StatusLine({ status, advice = false }: { status: Status; advice?: boolean }) {
  const thinking = status !== "listening";
  return (
    <div className="overlay-status">
      <span className="overlay-status-copy">
        <Mascot state={thinking ? "thinking" : "listening"} />
        <span className="overlay-status-label">{STATUS_LABEL[status]}</span>
      </span>
      {advice && (
        <span className="sx srecommend" aria-hidden="true">
          <SparklesIcon />
          {!thinking && <span>Advice</span>}
        </span>
      )}
    </div>
  );
}

function SpeakerLabel({ channel }: { channel: Channel }) {
  return (
    <span className="speaker-label">{channel === "other" ? "System audio" : "Microphone"}</span>
  );
}

export function TranscriptPane({ turns }: { turns: Turn[] }) {
  return (
    <div className="stext-cap">
      <p>
        {turns.map((turn, index) => (
          <span key={turn.id}>
            {(index === 0 || turns[index - 1]?.channel !== turn.channel) && (
              <SpeakerLabel channel={turn.channel} />
            )}
            <span className={turn.interim ? "interim" : undefined}>{turn.text}</span>{" "}
          </span>
        ))}
        <span className="scaret" />
      </p>
    </div>
  );
}

export const WAVE = [0.35, 0.55, 0.8, 1, 0.7, 0.9, 0.6, 0.45, 0.3];

function formatElapsed(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function BaseBar({ elapsed }: { elapsed: number }) {
  return (
    <div className="sbase">
      <div className="sbase-l">
        <span className="sx spause" aria-hidden="true">
          <MicOffIcon />
        </span>
      </div>
      <div className="swave" aria-hidden="true">
        {WAVE.map((weight, index) => (
          <i
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed bar layout
            key={index}
            style={
              {
                "--h": `${3 + weight * 15}px`,
                "--d": `${(index % 4) * 0.13 + (index % 3) * 0.07}s`,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div className="sbase-r">
        <span className="stimer">{formatElapsed(elapsed)}</span>
        <span className="sx sstop" aria-hidden="true">
          <StopIcon />
        </span>
      </div>
    </div>
  );
}
