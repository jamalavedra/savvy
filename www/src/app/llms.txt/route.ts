import { getAllPosts } from "@/lib/blog";
import { LINKS, REPO_URL, SITE_URL } from "@/lib/constants";

export const dynamic = "force-static";

export function GET() {
  return new Response(
    `# Savvy

> Savvy is a free, open-source macOS meeting assistant under the MIT license. It prepares a brief from your source documents and offers source-grounded guidance during a conversation.

## What it does

- Reads source documents without copying or changing them. Preparation can focus on a client or stay general.
- Responds when the other side asks a question, someone touches a hard constraint from the brief, or you press Advice.
- Between triggers, re-reads the brief and notes against the last minute of conversation. The status shows "Checking notes", then "Thinking". A "Savvy noticed" card appears if it finds something concrete.
- Uses a visible panel. Savvy has no hidden mode.

## Requirements and data handling

- macOS 13+ on Apple Silicon. Intel is buildable from source but unsupported.
- Transcription requires a Deepgram or AssemblyAI account. Savvy streams meeting audio to that provider as it captures it. There is no offline transcription mode.
- Savvy sets Deepgram's mip_opt_out=true to prevent model training on your audio. Check AssemblyAI's terms for its equivalent.
- Recommendations require Codex CLI or Claude Code installed and signed in. Savvy sends selected excerpts, the whole brief document, and recent relevant transcript turns to that CLI's model provider under your account and its terms.
- Derived chunks and indexes live in private local SQLite. Provider credentials live in macOS Keychain; only the authorization header goes to the provider.
- Savvy deletes local audio and transcripts after 30 days, with cleanup at startup. Removing a client deletes derived data without touching the source folder.
- App directories use 0700 permissions and sensitive files 0600. FileVault encrypts data at rest when enabled. Savvy does not add application-layer encryption.

## Links

- [Homepage](${SITE_URL}/)
- [Privacy policy](${SITE_URL}/privacy/)
- [Data handling](${SITE_URL}/#privacy)
- [FAQ](${SITE_URL}/#faq)
- [Blog](${SITE_URL}/blog/)
- [Download](${LINKS.download})
- [Source code and README](${REPO_URL})
- [MIT license](${LINKS.license})
- [Security policy](${LINKS.security})

## Blog posts

${getAllPosts()
  .map((post) => `- [${post.title}](${SITE_URL}/blog/${post.slug}/)`)
  .join("\n")}
`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}
