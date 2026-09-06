import { FadeInUp } from "@/components/animations/FadeInUp";
import { TwoLineHeading } from "@/components/sections/primitives";
import { faqItems } from "@/content/faq";
import { LINKS } from "@/lib/constants";

export function FAQ() {
  return (
    <section id="faq" className="py-20 lg:py-28">
      <div className="page-column grid gap-10 lg:grid-cols-[1fr_1.4fr]">
        <FadeInUp>
          <TwoLineHeading line1="Questions about Savvy" />
          <a
            href={LINKS.readme}
            className="focus-ring mt-6 inline-flex rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-background"
          >
            Read the README
          </a>
        </FadeInUp>
        <FadeInUp delay={0.1}>
          {faqItems.map((item, i) => (
            <details
              key={item.question}
              name="faq"
              open={i === 0}
              className="group px-6 py-1.5 open:bg-background-alt"
            >
              <summary className="focus-ring cursor-pointer py-3.5 text-[15px] font-medium">
                {item.question}
              </summary>
              <p className="pb-4 text-sm leading-relaxed text-muted">{item.answer}</p>
            </details>
          ))}
        </FadeInUp>
      </div>
    </section>
  );
}
