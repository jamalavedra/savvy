import type { Metadata } from "next";
import { FadeInUp } from "@/components/animations/FadeInUp";
import { Footer } from "@/components/layout/Footer";
import { Rail } from "@/components/layout/Rail";
import { CHECK_PATH, TwoLineHeading } from "@/components/sections/primitives";
import { DownloadCTA, GitHubCTA } from "@/components/ui/DownloadCTA";
import { REQUIREMENTS, SITE_URL } from "@/lib/constants";
import catalog from "../../../../config/managed-catalog.json";

const TITLE = "Pricing | Savvy";
const DESCRIPTION =
  "Savvy is free and open source with your own providers. Savvy managed is $79 a month for 10 meeting hours, or a $29 pack of 3 hours.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/pricing/" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: `${SITE_URL}/pricing/` },
};

type Plan = {
  name: string;
  price: string;
  unit: string;
  summary: string;
  features: string[];
  featured?: boolean;
};

const { monthly, pack } = catalog;

const PLANS: Plan[] = [
  {
    name: "Your own providers",
    price: "$0",
    unit: "free forever",
    summary: "The full app, MIT-licensed. You pay your providers directly and nothing to Savvy.",
    features: [
      "Your Deepgram or AssemblyAI key, billed per audio minute by them",
      "Your signed-in Claude Code or Codex CLI, on the plan you already have",
      "No Savvy account, no seats, no model markup",
    ],
  },
  {
    name: "Savvy managed",
    price: `$${monthly.amountCents / 100}`,
    unit: "per month",
    summary: "Sign in from the same app. Savvy handles transcription and model access.",
    features: [
      `${monthly.hours} meeting hours and ${monthly.briefs} briefs a month`,
      "Included allowance expires at the end of the paid period",
      "No keys or CLIs to set up",
    ],
    featured: true,
  },
  {
    name: "Hours pack",
    price: `$${pack.amountCents / 100}`,
    unit: "one time",
    summary: "Managed assistance for an occasional important call.",
    features: [`${pack.hours} meeting hours and ${pack.briefs} briefs`, "No scheduled expiry"],
  },
];

const FINE_PRINT = [
  "Prices are in USD.",
  "Microphone and system audio share one meeting clock.",
  "Pausing stops usage. There are no automatic overages.",
  "Failed briefs do not consume allowance.",
  "After adding allowance, resume a paused meeting yourself.",
  "Stripe hosts checkout and billing, opened from your signed-in desktop account. Returning from checkout does not confirm payment.",
];

function Check() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="mt-[3px] shrink-0 text-success"
    >
      <path d={CHECK_PATH} />
    </svg>
  );
}

function PlanCard({ plan }: { plan: Plan }) {
  return (
    <li
      className={`flex flex-col rounded-[22px] p-7 ${
        plan.featured ? "bg-foreground text-background" : "bg-surface ring-1 ring-border"
      }`}
    >
      <h2 className="text-body font-semibold">{plan.name}</h2>
      <p className="mt-5 flex items-baseline gap-2">
        <span className="text-display font-semibold tracking-tight">{plan.price}</span>
        <span className={`text-small ${plan.featured ? "text-white/70" : "text-muted"}`}>
          {plan.unit}
        </span>
      </p>
      <p className={`mt-3 text-small ${plan.featured ? "text-white/70" : "text-muted"}`}>
        {plan.summary}
      </p>
      <ul
        className={`mt-6 space-y-3 border-t pt-6 text-small ${
          plan.featured ? "border-white/15" : "border-border"
        }`}
      >
        {plan.features.map((feature) => (
          <li key={feature} className="flex gap-2.5">
            <Check />
            {feature}
          </li>
        ))}
      </ul>
    </li>
  );
}

export default function Pricing() {
  return (
    <>
      <Rail active="/pricing/" />
      <main id="main" tabIndex={-1} className="overflow-x-clip">
        <section className="py-20 lg:py-28">
          <div className="page-column">
            <FadeInUp>
              <TwoLineHeading
                as="h1"
                line1="One app, two ways to pay"
                line2="Free with your own accounts, or managed by us"
              />
              <p className="mt-4 text-small text-muted">{REQUIREMENTS}</p>
            </FadeInUp>

            <FadeInUp delay={0.08}>
              <ul className="mt-12 grid gap-4 lg:grid-cols-3">
                {PLANS.map((plan) => (
                  <PlanCard key={plan.name} plan={plan} />
                ))}
              </ul>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <DownloadCTA />
                <GitHubCTA />
                <p className="text-small text-muted">
                  Every plan starts with the same download. Managed plans are bought from inside the
                  app.
                </p>
              </div>
              <p className="mt-4 text-small text-muted">
                Teams buy seats at the monthly price each; manage at{" "}
                <a href="https://api.savvycopilot.com/team">api.savvycopilot.com/team</a>. Each seat
                has its own allowance. Seat quantity changes take effect at the next paid renewal.
              </p>
            </FadeInUp>
          </div>
        </section>

        <section className="pb-20 lg:pb-28">
          <div className="page-column grid gap-10 lg:grid-cols-[1fr_1.4fr]">
            <FadeInUp>
              <TwoLineHeading line1="Where processing happens" line2="And what you pay for" />
            </FadeInUp>
            <FadeInUp delay={0.08}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl bg-background-alt p-6">
                  <p className="text-body font-semibold">Your own providers</p>
                  <p className="mt-2 text-small text-muted">
                    Audio goes to your transcription provider and selected context to your model
                    provider, under your accounts.
                  </p>
                </div>
                <div className="rounded-2xl bg-background-alt p-6">
                  <p className="text-body font-semibold">Savvy managed</p>
                  <p className="mt-2 text-small text-muted">
                    Audio passes through Savvy to Deepgram, and selected document evidence and
                    meeting context through Savvy to Fireworks GLM-5.3. The price covers that usage
                    plus Savvy&apos;s margin.
                  </p>
                </div>
              </div>
              <p className="mt-4 text-small text-muted">
                Either way, your source documents and history stay on your Mac.
              </p>
              <ul className="mt-10 space-y-2 border-t border-border pt-6 text-small text-muted">
                {FINE_PRINT.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </FadeInUp>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
