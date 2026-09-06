import Link from "next/link";
import type { ReactNode } from "react";

// Hand-rolled renderer for the Markdown subset the posts use: ##/### headings,
// paragraphs, -/1. lists, > quotes, ---, **bold**, `code` and [links](url).
// Same approach as renderBriefMarkdown in the app; add a real parser only
// when a post needs more than this.

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

function inline(text: string): ReactNode[] {
  // Keyed by character offset: stable, unique, and not an array index.
  let offset = 0;
  return text.split(INLINE).map((part) => {
    const i = offset;
    offset += part.length;
    if (part.startsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`")) {
      return (
        <code key={i} className="rounded bg-background-alt px-1.5 py-0.5 font-mono text-[13px]">
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = LINK.exec(part);
    if (link) {
      const [, label = "", href = ""] = link;
      const className =
        "underline decoration-border underline-offset-4 hover:decoration-foreground";
      return href.startsWith("/") ? (
        <Link key={i} href={href} className={className}>
          {label}
        </Link>
      ) : (
        <a key={i} href={href} className={className} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      );
    }
    return part;
  });
}

const UL = /^[-*]\s+/;
const OL = /^\d+\.\s+/;

function takeWhile(lines: string[], from: number, test: (line: string) => boolean): string[] {
  const out: string[] = [];
  for (let i = from; i < lines.length && test(lines[i] ?? ""); i += 1) out.push(lines[i] ?? "");
  return out;
}

export function Markdown({ body }: { body: string }) {
  const lines = body.split(/\r?\n/).map((line) => line.trimEnd());
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
    } else if (line === "---") {
      blocks.push(<hr key={i} className="my-10 border-border" />);
      i += 1;
    } else if (line.startsWith("### ")) {
      blocks.push(
        <h3 key={i} className="mt-8 text-base font-semibold">
          {inline(line.slice(4))}
        </h3>,
      );
      i += 1;
    } else if (line.startsWith("## ")) {
      blocks.push(
        <h2 key={i} className="mt-12 text-xl font-medium tracking-tight">
          {inline(line.slice(3))}
        </h2>,
      );
      i += 1;
    } else if (line.startsWith(">")) {
      const quote = takeWhile(lines, i, (l) => l.startsWith(">"));
      blocks.push(
        <blockquote key={i} className="mt-5 border-l-2 border-border pl-4 text-muted">
          {inline(quote.map((l) => l.replace(/^>\s?/, "")).join(" "))}
        </blockquote>,
      );
      i += quote.length;
    } else if (UL.test(line) || OL.test(line)) {
      const ordered = OL.test(line);
      const pattern = ordered ? OL : UL;
      const items = takeWhile(lines, i, (l) => pattern.test(l));
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={i} className={`mt-5 space-y-2 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}>
          {items.map((item, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static content, never reordered
            <li key={n} className="pl-1">
              {inline(item.replace(pattern, ""))}
            </li>
          ))}
        </Tag>,
      );
      i += items.length;
    } else {
      const para = takeWhile(
        lines,
        i,
        (l) =>
          !!l.trim() &&
          !l.startsWith("#") &&
          !l.startsWith(">") &&
          l !== "---" &&
          !UL.test(l) &&
          !OL.test(l),
      );
      blocks.push(
        <p key={i} className="mt-5">
          {inline(para.join(" "))}
        </p>,
      );
      i += para.length;
    }
  }
  return <>{blocks}</>;
}
