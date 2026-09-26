import type { Metadata } from "next";
import { DownloadCTA } from "@/components/ui/DownloadCTA";
import catalog from "../../../../config/managed-catalog.json";

export const metadata: Metadata = {
  title: "Pricing | Savvy",
  description:
    "One free open-source desktop app. Connect your own providers or choose Savvy managed assistance.",
  alternates: { canonical: "/pricing/" },
};

export default function Pricing() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 leading-relaxed sm:py-20 [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-2xl [&_p]:mt-3">
      <a href="/" className="focus-ring underline">
        Back to Savvy
      </a>
      <h1 className="mt-8 text-4xl font-medium tracking-tight">One app, two ways to use it</h1>
      <h2>Personal providers</h2>
      <p>
        The desktop app is free and open source under the MIT license. Connect your transcription
        account and signed-in Claude Code or Codex CLI. You pay those providers directly.
      </p>
      <h2>Savvy managed</h2>
      <p>Sign in from the same desktop app. Savvy handles transcription and model access.</p>
      {Object.entries(catalog).map(([product, offer]) => (
        <section key={product} aria-label={product === "monthly" ? "Monthly plan" : "Hours pack"}>
          <h2>
            ${offer.amountCents / 100}
            {offer.interval ? "/month" : " hours pack"}
          </h2>
          <p>
            {offer.hours} meeting hours and {offer.briefs} briefs.{" "}
            {offer.expiry === "none"
              ? "No scheduled expiry."
              : "Included allowance expires at the paid period end."}
          </p>
        </section>
      ))}
      <p>
        Prices are in USD. Two audio sources share one meeting clock. Pausing stops usage. No
        automatic overages. Failed briefs do not consume allowance. After adding allowance,
        explicitly resume a paused meeting.
      </p>
      <p>
        Stripe hosts checkout and billing management, opened from your signed-in desktop account.
        Returning from checkout does not confirm payment.
      </p>
      <h2>Where processing happens</h2>
      <p>
        With personal providers, audio and selected context go to your providers. With managed
        assistance, audio passes through Savvy to Deepgram, and selected document evidence and
        meeting context pass through Savvy to Claude. Your source documents and history stay on your
        Mac.
      </p>
      <div className="mt-8">
        <DownloadCTA />
      </div>
    </main>
  );
}
