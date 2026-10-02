import { Footer } from "@/components/layout/Footer";
import { Rail } from "@/components/layout/Rail";
import { DataFootnote } from "@/components/sections/DataFootnote";
import { Everything } from "@/components/sections/Everything";
import { FAQ } from "@/components/sections/FAQ";
import { Hero } from "@/components/sections/Hero";
import { Privacy } from "@/components/sections/Privacy";
import { Divider } from "@/components/sections/primitives";
import { Reasons } from "@/components/sections/Reasons";
import { SourceBand } from "@/components/sections/SourceBand";
import { YourModel } from "@/components/sections/YourModel";
import { faqItems } from "@/content/faq";
import { COMPANY_NAME, CONTACT_EMAIL, LINKS, REPO_URL, SITE_URL, X_URL } from "@/lib/constants";

const ORG_ID = `${SITE_URL}/#organization`;

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": ORG_ID,
      name: COMPANY_NAME,
      legalName: "Alamas Labs, Inc.",
      url: SITE_URL,
      logo: `${SITE_URL}/images/logo/icon.png`,
      email: CONTACT_EMAIL,
      sameAs: [X_URL, REPO_URL],
      contactPoint: {
        "@type": "ContactPoint",
        contactType: "customer support",
        email: CONTACT_EMAIL,
      },
    },
    {
      "@type": "SoftwareApplication",
      name: "Savvy",
      url: SITE_URL,
      applicationCategory: "BusinessApplication",
      operatingSystem: "macOS 13 or later (Apple Silicon)",
      description:
        "Local-first macOS meeting assistant. Prepares a brief from your own source documents, then offers source-grounded guidance during a live conversation: what to say, what to avoid, and which file says so.",
      downloadUrl: LINKS.download,
      softwareHelp: LINKS.readme,
      license: LINKS.license,
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      author: { "@id": ORG_ID },
      publisher: { "@id": ORG_ID },
      sameAs: [REPO_URL],
    },
    {
      "@type": "WebSite",
      url: SITE_URL,
      name: "Savvy",
      inLanguage: "en",
      publisher: { "@id": ORG_ID },
    },
    {
      "@type": "FAQPage",
      "@id": `${SITE_URL}/#faq`,
      mainEntity: faqItems.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    },
  ],
};

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD, no user input
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Rail />
      <main id="main" className="overflow-x-clip">
        <Hero />
        <Divider />
        <Reasons />
        <Divider />
        <SourceBand />
        <Divider />
        <Everything />
        <Divider />
        <YourModel />
        <Divider />
        <Privacy />
        <Divider />
        <FAQ />
        <Divider />
        <DataFootnote />
      </main>
      <Footer />
    </>
  );
}
