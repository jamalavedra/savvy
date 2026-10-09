import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy policy | Savvy",
  description: "How the Savvy website and desktop app handle information.",
  alternates: { canonical: "/privacy/" },
  openGraph: {
    title: "Privacy policy | Savvy",
    description: "How the Savvy website and desktop app handle information.",
    url: "/privacy/",
  },
};

export default function PrivacyPolicy() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-sm leading-relaxed sm:py-20 [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-medium [&_p]:mt-3 [&_a]:underline [&_a]:underline-offset-4">
      <a href="/" className="focus-ring">
        Back to Savvy
      </a>
      <h1 className="mt-8 text-4xl font-medium tracking-tight">Privacy policy</h1>
      <p className="text-muted">Last updated 12 September 2026</p>

      <h2>Who is responsible</h2>
      <p>
        Alamas Labs, Inc., a Delaware corporation in the United States, operates savvycopilot.com
        and is responsible for the website and managed-service processing described here. Contact{" "}
        <a href="mailto:hello@savvycopilot.com">hello@savvycopilot.com</a> with privacy questions or
        requests.
      </p>
      <p>
        This notice covers the public website, the desktop app, and Savvy managed assistance. You
        can use your own providers or choose managed assistance. Those choices send information
        through different services, as described below.
      </p>

      <h2>Website hosting and security</h2>
      <p>
        Cloudflare delivers this website and protects it from abuse. Requests include your IP
        address, the requested URL, browser information, and connection details. Cloudflare
        processes this information to serve pages, maintain reliability, and detect malicious
        traffic. We rely on our legitimate interest in operating a secure, working website for this
        processing.
      </p>
      <p>
        Cloudflare operates internationally, so processing can take place outside your country,
        including outside the European Economic Area. Its data processing terms describe the
        safeguards that apply to international transfers, including standard contractual clauses.
        See <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare's privacy policy</a> and
        its <a href="https://www.cloudflare.com/cloudflare-customer-dpa/">data processing terms</a>.
      </p>

      <h2>Website analytics</h2>
      <p>
        With your permission, we use our Umami installation at analytics.jamalavedra.com to
        understand how people find and use this website. It records page visits, referring URLs,
        visit times, browser and device information, language, and approximate location. Page URLs
        can include query parameters. Please do not put private information in links to this site.
      </p>
      <p>
        Umami's tracking script does not use cookies. Umami processes IP addresses and browser
        information to derive location and generate session identifiers. Umami does not store raw IP
        addresses in its analytics records, but generating session identifiers still involves
        processing connection information. Hosting infrastructure can process connection data
        separately.
      </p>
      <p>
        This website does not supply names, email addresses, or account identifiers to Umami. The
        installed snippet does not enable session replay or heatmaps. Website analytics does not
        collect your desktop app's documents, meeting audio, or transcripts.
      </p>
      <p>
        We rely on consent for optional analytics. It stays off until you choose Allow analytics.
        Use the Privacy preferences control on any page to reject analytics or withdraw your
        consent. This browser stores your choice locally for up to one year. Clearing browser
        storage removes it. Withdrawing consent stops future collection; it does not undo earlier
        lawful processing or automatically delete existing records.
      </p>
      <p>
        We do not run advertising trackers or sell your personal information. Our self-hosted
        analytics service and its hosting infrastructure process the visit data described above. We
        operate from the United States and use infrastructure that may process data in other
        countries. Where required for transfers from the EEA or UK, we use appropriate safeguards,
        including standard contractual clauses. Contact us for information about those safeguards.
      </p>

      <h2>How long we keep information</h2>
      <p>
        We retain analytics while it remains useful for website reporting and improvement. Analytics
        records have no fixed expiry. We delete them manually. Our hosting providers handle
        connection and security records according to their applicable service terms and policies.
        The desktop app has a separate local retention rule, explained below.
      </p>

      <h2>Desktop storage and your own providers</h2>
      <p>
        The current desktop app reads source files from folders you choose and stores extracted
        text, indexes, briefs, recordings, and transcripts on your Mac. It leaves the source files
        unchanged. At startup, Savvy deletes local recordings and transcripts older than 30 days.
        This startup cleanup does not delete copies held by providers or backups.
      </p>
      <p>
        When you use your own providers, Savvy streams audio to your Deepgram or AssemblyAI account
        for transcription. There is no offline transcription mode. For recommendations, Savvy sends
        selected document excerpts, the whole brief, and recent transcript turns to your signed-in
        Codex or Claude Code CLI's provider. These services process information under your account
        and their own terms. Review those terms and settings before using confidential material or
        recording other people.
      </p>

      <p>
        Savvy stores transcription API keys in macOS Keychain. The website's analytics service does
        not receive these keys. Removing a client in the app removes its derived local data without
        deleting the original source folder.
      </p>

      <h2>Managed accounts and payments</h2>
      <p>
        Managed sign-in uses Google identity or a code delivered to your email address. Savvy
        processes your verified identity, email address, display name when available, account
        identifiers, and sign-in and session records. Google access is limited to identity; Savvy
        does not request access to your email messages, calendar, or files. Our email delivery
        provider receives your email address and the sign-in message. Savvy counts sign-in attempts
        and rate-limits requests to block abuse. Signing in does not start listening or buy a plan.
      </p>
      <p>
        Stripe hosts checkout and billing management. Savvy records customer, subscription and
        purchase identifiers, purchase outcomes, allowance balances, usage, refunds and disputes to
        provide paid features and reconcile payments. Full card details are entered on Stripe, not
        in Savvy. See{" "}
        <a href="https://stripe.com/legal/privacy-center">Stripe’s privacy information</a>.
      </p>

      <h2>Managed meeting processing</h2>
      <p>
        When you explicitly start a managed meeting or transcription test, microphone audio and, if
        enabled, system audio pass through Savvy’s backend to Deepgram. For brief generation and
        recommendations, selected document excerpts, the brief and relevant recent transcript
        context pass through Savvy to Fireworks AI’s GLM-5.3 API. These are hosted supplier requests
        using Savvy’s service accounts. Personal-provider mode instead uses your own accounts.
      </p>
      <p>
        Savvy processes managed audio and model context in memory. Its account and billing databases
        store session timing, usage and supplier-request metadata, rather than raw audio, transcript
        text or document excerpts. Local copies remain subject to the desktop storage rules above.
        Stopping a meeting closes the audio relay to Deepgram; signing out does not delete local
        history or cancel a subscription.
      </p>
      <p>
        Suppliers have their own retention and security terms. Local deletion and sign-out do not
        delete supplier-held copies. Savvy requests Deepgram’s model-improvement opt-out; this is
        not a promise of zero retention by every supplier. Review{" "}
        <a href="https://deepgram.com/privacy">Deepgram’s privacy notice</a> and{" "}
        <a href="https://fireworks.ai/privacy-policy">Fireworks AI’s privacy notice</a> before
        submitting confidential material.
      </p>
      <p>
        Managed account, payment and usage records currently have no automatic expiry. Contact us to
        request access, correction or deletion of hosted records. We assess requests against
        account-security, accounting and other applicable obligations; deleting local files alone
        does not remove these hosted records. Savvy operates from the United States, and its
        suppliers may process information outside your country. Contact us for the applicable
        service providers, retention arrangements and international-transfer safeguards.
      </p>

      <h2>Contact and external links</h2>
      <p>
        If you contact us, we process the information you send to respond to your request. Our legal
        basis is our legitimate interest in responding to enquiries, or compliance with a legal
        obligation when handling data-protection requests. We keep correspondence in our business
        mailbox. If an enquiry does not lead to an engagement, we retain it for up to 24 months
        after the last contact. We keep client correspondence for the engagement and afterward as
        needed to meet legal and accounting obligations.
      </p>
      <p>
        GitHub hosts downloads, source code, and issue reports. If you follow those links, GitHub
        processes your visit under its own privacy notice. Issues in the public repository are
        public, so do not include personal information, recordings, API keys, or confidential
        documents in an issue.
      </p>

      <h2>Your rights</h2>
      <p>
        Depending on the law that applies, you can request access, correction, deletion,
        restriction, or portability of personal data we hold about you. You can object to processing
        based on legitimate interests. Where processing relies on consent, you can withdraw it
        without affecting earlier lawful processing.
      </p>
      <p>
        Contact <a href="mailto:hello@savvycopilot.com">hello@savvycopilot.com</a> to make a
        request. We may need enough information to verify and locate the relevant records. We cannot
        access or erase files that remain only on your Mac or data held in your own provider
        accounts.
      </p>
      <p>
        You can complain to your local data protection authority. In Spain, this is the
        <a href="https://www.aepd.es/"> Spanish Data Protection Agency</a>.
      </p>

      <h2>Changes to this notice</h2>
      <p>
        We will update this page when our processing changes and show the effective date here. We
        will explain material changes before the new processing begins.
      </p>
    </main>
  );
}
