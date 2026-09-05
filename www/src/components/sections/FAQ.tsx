"use client";

import * as Accordion from "@radix-ui/react-accordion";
import { FadeInUp } from "@/components/animations/FadeInUp";
import { TwoLineHeading } from "@/components/sections/primitives";
import { faqItems } from "@/content/faq";
import { LINKS } from "@/lib/constants";

// The open item is a filled block with a minus; closed items are plain rows
// with a plus. The vertical bar collapses instead of rotating, so the two
// states read as the same mark.
function PlusMinus() {
  return (
    <span aria-hidden className="relative block h-3 w-3 shrink-0">
      <span className="absolute left-0 top-1/2 h-[1.5px] w-full -translate-y-1/2 bg-current" />
      <span className="absolute left-1/2 top-0 h-full w-[1.5px] -translate-x-1/2 bg-current transition-transform duration-300 group-data-[state=open]:scale-y-0" />
    </span>
  );
}

export function FAQ() {
  return (
    <section id="faq" className="py-20 lg:py-28">
      <div className="page-column grid gap-10 lg:grid-cols-[1fr_1.4fr]">
        <FadeInUp>
          <TwoLineHeading
            line1="Your questions, answered"
            line2="Before you point it at anything"
          />
          <a
            href={LINKS.readme}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-6 inline-flex items-center rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-background transition-opacity hover:opacity-80"
          >
            Read the README
          </a>
        </FadeInUp>

        <FadeInUp delay={0.1}>
          <Accordion.Root type="single" collapsible defaultValue="q-0">
            {faqItems.map((item, i) => (
              <Accordion.Item
                key={item.question}
                value={`q-${i}`}
                className="group px-6 py-1.5 transition-colors data-[state=open]:bg-background-alt data-[state=open]:py-3"
              >
                <Accordion.Header>
                  <Accordion.Trigger className="focus-ring flex w-full items-center justify-between gap-4 py-3.5 text-left text-[15px] font-medium transition-colors hover:text-foreground/70 group-data-[state=open]:font-semibold">
                    {item.question}
                    <PlusMinus />
                  </Accordion.Trigger>
                </Accordion.Header>
                <Accordion.Content className="accordion-content overflow-hidden">
                  <p className="pb-4 pr-8 text-sm leading-relaxed text-muted">{item.answer}</p>
                </Accordion.Content>
              </Accordion.Item>
            ))}
          </Accordion.Root>
        </FadeInUp>
      </div>
    </section>
  );
}
