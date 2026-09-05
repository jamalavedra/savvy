import { FadeInUp } from "@/components/animations/FadeInUp";
import {
  ClockIcon,
  Eyebrow,
  FolderIcon,
  KeyIcon,
  StatList,
  TwoLineHeading,
  WaveIcon,
} from "@/components/sections/primitives";

// The README's data table, rendered verbatim in spirit: what stays, what
// leaves. The meeting-audio row is the one people miss, so it is the one row
// that carries the danger colour.
const P = {
  doc: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8",
  db: "M12 2C7.6 2 4 3.3 4 5s3.6 3 8 3 8-1.3 8-3-3.6-3-8-3ZM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM19 10v2a7 7 0 0 1-14 0v-2M12 19v3",
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
  clipboard:
    "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z",
  key: "M15.5 7.5 19 4M21 2l-2 2M7.5 20.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM10.7 13.3 17 7",
};

function RowIcon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="mr-2 inline-block shrink-0 align-[-2px] text-muted"
    >
      <path d={d} />
    </svg>
  );
}

const ROWS = [
  {
    icon: P.doc,
    data: "Documents",
    local: "Read-only, never copied",
    sent: "Excerpts, when asked",
  },
  { icon: P.db, data: "Indexes", local: "Local SQLite", sent: "Excerpts only" },
  {
    icon: P.mic,
    data: "Meeting audio",
    local: "Local, 30-day retention",
    sent: "Streamed to your transcription provider",
    alert: true,
  },
  {
    icon: P.chat,
    data: "Transcript",
    local: "Local, 30-day retention",
    sent: "Recent turns, when asked",
  },
  {
    icon: P.clipboard,
    data: "Brief",
    local: "Private, versioned",
    sent: "Whole brief, when asked",
  },
  { icon: P.key, data: "Credentials", local: "macOS Keychain", sent: "Authorization header only" },
];

export function Privacy() {
  return (
    <section id="privacy" className="py-20 lg:py-28">
      <div className="page-column grid items-center gap-12 lg:grid-cols-2">
        <FadeInUp>
          <Eyebrow>Local-first</Eyebrow>
          <TwoLineHeading
            className="mt-4"
            line1="Stays on your Mac"
            line2="Honest about what doesn't"
          />
          <p className="mt-6 max-w-md text-sm leading-relaxed text-muted">
            Documents are read where they live and never copied. Indexes sit in a private local
            SQLite database that only your account can open. Audio and transcripts are deleted after
            30 days. The honest part: audio streams to your transcription provider as it is
            captured, and excerpts plus recent turns go to the model your CLI is signed in to.
          </p>
          <StatList
            items={[
              { icon: FolderIcon, label: "Documents referenced read-only, never copied" },
              { icon: KeyIcon, label: "Provider keys in the macOS Keychain" },
              { icon: ClockIcon, label: "Audio and transcripts deleted after 30 days" },
              { icon: WaveIcon, label: "Audio streams only to your transcription provider" },
            ]}
          />
        </FadeInUp>

        <FadeInUp delay={0.1}>
          <div className="bg-background-alt p-5 sm:p-8">
            <div className="overflow-hidden rounded-2xl border border-border bg-surface">
              <table className="w-full table-fixed">
                <colgroup>
                  <col className="w-[26%]" />
                  <col className="w-[33%]" />
                  <col className="w-[41%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-border font-mono text-[10px] uppercase tracking-wider text-muted">
                    <th className="px-3 py-3 text-left font-normal sm:px-4">Data</th>
                    <th className="px-3 py-3 text-left font-normal sm:px-4">On your Mac</th>
                    <th className="px-3 py-3 text-left font-normal sm:px-4">Sent</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-soft">
                  {ROWS.map((row) => (
                    <tr key={row.data} className="align-top text-[12px] leading-snug">
                      <td className="min-w-0 break-words px-3 py-3 font-medium sm:px-4">
                        <RowIcon d={row.icon} />
                        {row.data}
                      </td>
                      <td className="min-w-0 break-words px-3 py-3 text-muted sm:px-4">
                        {row.local}
                      </td>
                      <td
                        className={`min-w-0 break-words px-3 py-3 sm:px-4 ${
                          row.alert ? "font-medium text-danger" : "text-muted"
                        }`}
                      >
                        <span
                          aria-hidden
                          className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${
                            row.alert ? "bg-danger" : "bg-border"
                          }`}
                        />
                        {row.sent}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </FadeInUp>
      </div>
    </section>
  );
}
