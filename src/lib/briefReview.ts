const MAX_PREVIEW_CHARACTERS = 20_000;
const MAX_PREVIEW_LINES = 200;

export function briefMarkdownPreview(markdown: string) {
  const lines = markdown
    .slice(0, MAX_PREVIEW_CHARACTERS)
    .split(/\r?\n/, MAX_PREVIEW_LINES + 1);
  return {
    markdown: lines.slice(0, MAX_PREVIEW_LINES).join("\n"),
    truncated:
      markdown.length > MAX_PREVIEW_CHARACTERS ||
      lines.length > MAX_PREVIEW_LINES,
  };
}

/** Read only the current document; imported/edited briefs may have stale metadata. */
export function briefReviewSections(markdown: string) {
  if (briefMarkdownPreview(markdown).truncated) return null;
  // Custom documents with fenced code use the full preview; do not interpret
  // headings inside code as meeting instructions.
  if (/^\s*(`{3,}|~{3,})/m.test(markdown) || /^#{3,6}\s/m.test(markdown))
    return null;
  const sections = new Map<string, string[]>();
  let heading = "";
  sections.set(heading, []);
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      if (match[1] !== "##") return null;
      heading = match[2].toLowerCase();
      if (!sections.has(heading)) sections.set(heading, []);
    } else sections.get(heading)?.push(line);
  }
  const read = (name: string) => sections.get(name)?.join("\n").trim() ?? "";
  const allowed = new Set([
    "objective",
    "questions to ask",
    "watch for",
    "red lines",
    "prohibited claims",
    "unauthorized commitments",
    "risks",
  ]);
  // Summarize only when every body section is represented. Unknown sections or
  // preamble must remain visible because the model receives the full document.
  if (
    [...sections].some(
      ([name, lines]) =>
        !allowed.has(name) &&
        (Boolean(name) || lines.some((line) => line.trim())),
    )
  )
    return null;
  const objective = read("objective");
  const questions = read("questions to ask");
  const guardrails = [
    "watch for",
    "red lines",
    "prohibited claims",
    "unauthorized commitments",
    "risks",
  ]
    .map(read)
    .filter(Boolean)
    .join("\n\n");
  // No inferred summary when the supplied document uses different headings.
  if (!objective || !questions || !guardrails) return null;
  return [
    { title: "Objective", content: objective },
    { title: "Questions to ask", content: questions },
    { title: "Watch for", content: guardrails },
  ];
}

/** Exact source pages, bounded independently of the number of Markdown nodes. */
export function briefReviewPages(markdown: string): string[] {
  const pages: string[] = [];
  let start = 0;
  let lines = 0;
  for (let i = 0; i < markdown.length; i++) {
    if (markdown[i] === "\n") lines++;
    if (i - start + 1 >= 12_000 || lines >= 180) {
      // Keep UTF-16 surrogate pairs together at character boundaries.
      if (markdown.charCodeAt(i) >= 0xd800 && markdown.charCodeAt(i) <= 0xdbff)
        i++;
      pages.push(markdown.slice(start, i + 1));
      start = i + 1;
      lines = 0;
    }
  }
  if (start < markdown.length) pages.push(markdown.slice(start));
  return pages.length ? pages : [""];
}
