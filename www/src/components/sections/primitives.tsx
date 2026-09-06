import type { ReactNode } from "react";

// Shared bits for the money.x.com-style sections: tiny square-bullet eyebrow,
// two-line heading (ink line + muted line), section hairline, and the
// icon+label stat rows that sit in section side columns.

/** Section hairline, clipped to the content column so it never runs under
 *  the fixed left rail. */
export function Divider() {
  return (
    <div className="page-column">
      <div className="border-t border-border" />
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium">
      <span aria-hidden className="h-1.5 w-1.5 border border-foreground/50" />
      {children}
    </span>
  );
}

export function TwoLineHeading({
  line1,
  line2,
  className = "",
  as: Tag = "h2",
}: {
  line1: ReactNode;
  line2?: ReactNode;
  className?: string;
  as?: "h1" | "h2";
}) {
  return (
    <Tag
      className={`text-3xl font-medium leading-[1.12] tracking-tight lg:text-[40px] ${className}`}
    >
      <span className="block">{line1}</span>
      {line2 && <span className="block text-muted">{line2}</span>}
    </Tag>
  );
}

export type Stat = { icon: ReactNode; label: ReactNode };

export function StatList({ items }: { items: Stat[] }) {
  return (
    <ul className="mt-8">
      {items.map((item, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: static list, never reordered
          key={i}
          className="flex items-center gap-3 border-t border-border py-4 text-sm font-medium last:border-b"
        >
          <span className="text-muted">{item.icon}</span>
          {item.label}
        </li>
      ))}
    </ul>
  );
}

const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export const QuestionIcon = (
  <svg {...iconProps} aria-hidden="true">
    <circle cx="8" cy="8" r="5.5" />
    <path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.5-.7 1M8 11.2h.01" />
  </svg>
);

export const FlagIcon = (
  <svg {...iconProps} aria-hidden="true">
    <path d="M3.5 14V2.5M3.5 3h8l-1.5 3 1.5 3h-8" />
  </svg>
);

export const SparkIcon = (
  <svg {...iconProps} aria-hidden="true">
    <path d="M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3L8 2.5Z" />
    <path d="M12.5 11.5v2M11.5 12.5h2" />
  </svg>
);

export const MuteIcon = (
  <svg {...iconProps} aria-hidden="true">
    <path d="M6 6.5v-2a2 2 0 0 1 4 0v3.5M4.5 8.5a3.5 3.5 0 0 0 6.2 2.2M8 12v2M2.5 2.5l11 11" />
  </svg>
);

export const FolderIcon = (
  <svg {...iconProps} aria-hidden="true">
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
  </svg>
);

export const KeyIcon = (
  <svg {...iconProps} aria-hidden="true">
    <circle cx="5.5" cy="10.5" r="3" />
    <path d="M7.75 8.25 13.5 2.5M11 5l2 2" />
  </svg>
);

export const ClockIcon = (
  <svg {...iconProps} aria-hidden="true">
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3l2 1.5" />
  </svg>
);

export const ShieldIcon = (
  <svg {...iconProps} aria-hidden="true">
    <path d="M8 2.5 13 4.5v3.6c0 3-2.1 4.9-5 5.9-2.9-1-5-2.9-5-5.9V4.5L8 2.5Z" />
  </svg>
);

export const WaveIcon = (
  <svg {...iconProps} aria-hidden="true">
    <path d="M2.5 8h1M5 5.5v5M8 3v10M11 5.5v5M13.5 8h-1" />
  </svg>
);

export const TerminalIcon = (
  <svg {...iconProps} aria-hidden="true">
    <path d="M3 5l3 3-3 3M8 11h5" />
  </svg>
);

export const UserIcon = (
  <svg {...iconProps} aria-hidden="true">
    <circle cx="8" cy="5.5" r="2.5" />
    <path d="M3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4" />
  </svg>
);

export const LaptopIcon = (
  <svg {...iconProps} aria-hidden="true">
    <rect x="3" y="3.5" width="10" height="7" rx="1" />
    <path d="M1.5 12.5h13" />
  </svg>
);

export const DocIcon = (
  <svg {...iconProps} aria-hidden="true">
    <path d="M4 2.5h5l3 3v8H4v-11Z" />
    <path d="M9 2.5v3h3M6 8.5h4M6 10.5h4" />
  </svg>
);
