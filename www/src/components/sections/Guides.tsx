import Link from "next/link";
import { TwoLineHeading } from "@/components/sections/primitives";

const GUIDES = [
  {
    href: "/blog/what-real-time-meeting-assistant-means/",
    question: "Do you need notes or help during the call?",
    description: "Compare live transcripts, summaries, coaching and guidance from your documents.",
  },
  {
    href: "/blog/meeting-prep/",
    question: "What should you prepare before a client meeting?",
    description: "A 20-minute checklist for the facts, questions and limits to bring into a call.",
  },
  {
    href: "/blog/local-first-meeting-assistant-vs-meeting-bots/",
    question: "Where does a bot-free assistant send your audio?",
    description: "Check capture, storage and provider choices before using confidential material.",
  },
] as const;

export function Guides() {
  return (
    <section aria-labelledby="guides-title" className="py-20 lg:py-28">
      <div className="page-column">
        <div id="guides-title">
          <TwoLineHeading line1="Choose what fits your calls" line2="Start with the question" />
        </div>
        <ul className="mt-10 grid gap-6 md:grid-cols-3">
          {GUIDES.map((guide) => (
            <li key={guide.href}>
              <Link
                href={guide.href}
                className="focus-ring block h-full rounded-2xl border border-border p-6 transition-colors hover:bg-background-alt"
              >
                <h3 className="text-body font-semibold">{guide.question}</h3>
                <p className="mt-3 text-small text-muted">{guide.description}</p>
                <span className="mt-5 inline-block text-small font-medium">Read the guide →</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
