import { FadeInUp } from "@/components/animations/FadeInUp";
import { TwoLineHeading } from "@/components/sections/primitives";
import { faqItems } from "@/content/faq";
import { LINKS } from "@/lib/constants";

const BLOG_LINKS = [
  ["/blog/meeting-prep/", "How to prepare for a meeting"],
  ["/blog/granola-alternatives/", "Granola AI alternatives"],
  ["/blog/otter-ai-alternatives/", "Otter.ai alternatives"],
  ["/blog/cluely-alternatives/", "Cluely alternatives for work meetings"],
] as const;

export function FAQ() {
  return (
    <section id="faq" className="py-20 lg:py-28">
      <div className="page-column grid gap-10 lg:grid-cols-[1fr_1.4fr]">
        <FadeInUp>
          <TwoLineHeading line1="Questions about Savvy" />
          <a
            href={LINKS.readme}
            className="focus-ring press-feedback mt-6 inline-flex rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-background"
          >
            Read the README
          </a>
          <p className="mt-10 text-small font-semibold">From the blog</p>
          <ul className="mt-3 space-y-2 text-small text-muted">
            {BLOG_LINKS.map(([href, label]) => (
              <li key={href}>
                <a href={href} className="focus-ring underline underline-offset-4">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </FadeInUp>
        <FadeInUp delay={0.1}>
          {faqItems.map((item, i) => (
            <details
              key={item.question}
              name="faq"
              open={i === 0}
              className="group rounded-2xl px-6 py-1.5 open:bg-background-alt"
            >
              <summary className="focus-ring cursor-pointer py-3.5 text-body font-semibold">
                {item.question}
              </summary>
              <p className="pb-4 text-small text-muted">{item.answer}</p>
            </details>
          ))}
        </FadeInUp>
      </div>
    </section>
  );
}
