import Image from "next/image";
import type { CSSProperties, ReactNode } from "react";

// Building blocks of the overlay replica. Markup mirrors savvy/src/App.tsx
// (MeetingOverlay) so the landing renders the same DOM the app does.

export type Channel = "other" | "selfSpeaker";
export type Turn = { id: string; channel: Channel; text: string; interim?: boolean };
export type Status = "listening" | "muted" | "checking" | "question" | "risk" | "manual";
export type MascotState = "listening" | "muted" | "thinking";

export const STATUS_LABEL: Record<Status, string> = {
  listening: "Savvy is listening",
  muted: "Savvy is muted",
  checking: "Checking notes",
  question: "Answering their question",
  risk: "Checking a red line",
  manual: "Getting advice",
};

export function mascotFor(status: Status): MascotState {
  if (status === "listening") return "listening";
  if (status === "muted") return "muted";
  return "thinking";
}

const icon = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function MicIcon() {
  return (
    <svg {...icon} aria-hidden="true">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
    </svg>
  );
}

export function MicOffIcon() {
  return (
    <svg {...icon} aria-hidden="true">
      <path d="M2 2l20 20M18.89 13.23A7.12 7.12 0 0 0 19 12v-2M5 10v2a7 7 0 0 0 12 5" />
      <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33M9 9v3a3 3 0 0 0 5.12 2.12M12 19v3" />
    </svg>
  );
}

export function SparklesIcon() {
  return (
    <svg {...icon} aria-hidden="true">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4M22 5h-4M4 17v2M5 18H3" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg {...icon} aria-hidden="true">
      <rect x="14" y="4" width="4" height="16" rx="1" />
      <rect x="6" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

export function XIcon() {
  return (
    <svg {...icon} aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" />
    </svg>
  );
}

export function Mascot({
  state,
  size = 26,
  className = "",
}: {
  state: MascotState;
  size?: number;
  className?: string;
}) {
  return (
    <Image
      className={`mascot-state ${state} ${className}`}
      src={`/images/mascot/savvy-${state}.png`}
      alt=""
      width={size}
      height={size}
      draggable={false}
      style={size === 26 ? undefined : { width: size, height: size, flexBasis: size }}
    />
  );
}

/** Mascot + label row; the Advice chip appears once there is a transcript. */
export function StatusLine({
  status,
  advice = false,
  children,
}: {
  status: Status;
  advice?: boolean;
  children?: ReactNode;
}) {
  const thinking = status !== "listening" && status !== "muted";
  return (
    <div className="overlay-status">
      <span className="overlay-status-copy">
        <Mascot state={mascotFor(status)} />
        <span className="overlay-status-label">{children ?? STATUS_LABEL[status]}</span>
      </span>
      {advice && (
        <span className={`sx srecommend ${thinking ? "thinking" : ""}`} aria-hidden="true">
          <SparklesIcon />
          {!thinking && <span>Advice</span>}
        </span>
      )}
    </div>
  );
}

export function SpeakerLabel({ channel }: { channel: Channel }) {
  return (
    <span className="speaker-label">{channel === "other" ? "System audio" : "Microphone"}</span>
  );
}

/** The rolling transcript: speaker label on channel change, interim turns
 *  lighter, blinking caret at the end. */
export function TranscriptPane({ turns, caret = true }: { turns: Turn[]; caret?: boolean }) {
  return (
    <div className="stext-cap">
      <p>
        {turns.map((turn, index) => (
          <span key={turn.id}>
            {(index === 0 || turns[index - 1]?.channel !== turn.channel) && (
              <SpeakerLabel channel={turn.channel} />
            )}
            <span className={turn.interim ? "interim" : "committed"}>{turn.text}</span>{" "}
          </span>
        ))}
        {caret && <span className="scaret" />}
      </p>
    </div>
  );
}

const WAVE = [0.35, 0.55, 0.8, 1, 0.7, 0.9, 0.6, 0.45, 0.3];

export function formatElapsed(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Mute · waveform · timer · stop. */
export function BaseBar({ elapsed, paused = false }: { elapsed: number; paused?: boolean }) {
  return (
    <div className="sbase">
      <div className="sbase-l">
        <span className="sx spause" aria-hidden="true">
          {paused ? <MicIcon /> : <MicOffIcon />}
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
