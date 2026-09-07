import fs from "node:fs";
import path from "node:path";

// Posts are Markdown files in src/content/blog with a small frontmatter block.
// Read at build time only: the site is a static export, so nothing here runs
// in the browser.

export type Post = {
  slug: string;
  title: string;
  description: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  readingMinutes: number;
  tags: string[];
  body: string;
};

const POSTS_DIR = path.join(process.cwd(), "src/content/blog");
const REQUIRED = ["title", "description", "date"] as const;

function parsePost(file: string): Post {
  const raw = fs.readFileSync(path.join(POSTS_DIR, file), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`${file}: missing frontmatter block`);
  const [, head = "", body = ""] = match;
  const fields: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  for (const key of REQUIRED) {
    if (!fields[key]) throw new Error(`${file}: frontmatter is missing "${key}"`);
  }
  const date = fields.date ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${file}: date must be YYYY-MM-DD`);
  return {
    slug: file.replace(/\.md$/, ""),
    title: fields.title ?? "",
    description: fields.description ?? "",
    date,
    readingMinutes: Math.max(1, Math.ceil(body.split(/\s+/).length / 220)),
    tags: (fields.tags ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    body: body.trim(),
  };
}

/** Every post, newest first. */
export function getAllPosts(): Post[] {
  return fs
    .readdirSync(POSTS_DIR)
    .filter((file) => file.endsWith(".md"))
    .map(parsePost)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function getPost(slug: string): Post | undefined {
  return getAllPosts().find((post) => post.slug === slug);
}

export function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
