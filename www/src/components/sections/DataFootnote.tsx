import { LINKS } from "@/lib/constants";

export function DataFootnote() {
  return (
    <section className="py-12">
      <div className="page-column text-xs leading-relaxed text-muted">
        <p>
          Savvy is open-source software provided as-is under the{" "}
          <a
            href={LINKS.license}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 transition-colors hover:text-foreground"
          >
            MIT license
          </a>{" "}
          by Alamas Labs. Live transcription streams meeting audio to the transcription provider you
          configure. Recommendations send selected document excerpts, the brief and recent
          transcript turns to the model provider your CLI is signed in to, under your own account
          and its terms. Check the rules of your meeting before using AI assistance.
        </p>
      </div>
    </section>
  );
}
