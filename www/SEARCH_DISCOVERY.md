# Search discovery review

Reviewed on 29 October 2026 against the seven studies linked from the
[Discovered Labs case-study index](https://discoveredlabs.com/case-studies).

The studies describe agency engagements across content, technical SEO and external mentions.
They support hypotheses for Savvy, not a forecast. Their outcomes are self-reported, and the
contribution of an individual tactic cannot be isolated from these accounts. This review uses
Savvy's README, privacy policy, pricing catalog and existing website content to choose changes
that can be verified in this repository. Search Console, analytics reports and AI-answer
baselines were not available for this review.

## Findings from each study

| Study                                                                                                     | Transferable lesson                                                                                                                        | Application to Savvy                                                                                                                                                         | Evidence limit                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Gladia](https://discoveredlabs.com/case-studies/gladia)                                                  | Connect category pages and supporting articles around buyer decisions. Measure visibility, engagement and acquisition separately.          | Link the existing live-assistance, preparation and data-handling guides from the homepage. Connect the live-assistance guide to preparation and pricing.                     | The engagement combined content, technical fixes and external work. Its pipeline results do not establish the effect of internal links alone.                                                |
| [AdvisoryAI](https://discoveredlabs.com/case-studies/advisoryai)                                          | Decide whether an existing page needs a refresh before creating another page. Keep product identity and use cases clear.                   | Refresh existing articles at their current URLs. Explain personal providers and managed assistance consistently instead of adding competing pages for the same questions.    | Google rankings, AI citations and demo requests are different measures. They should remain separate in Savvy's evaluation.                                                                   |
| [GetVocal](https://discoveredlabs.com/case-studies/getvocal)                                              | Brand recognition does not establish discovery for category questions. Check internal links and whether each topic has a useful main page. | Use concrete, non-branded questions to introduce the existing guides. Test exported internal links, fragments and canonical URLs.                                            | The study notes changes to its prompt set, tracking configuration and response completeness. Its before-and-after AI coverage figures are not a controlled comparison.                       |
| [Granola](https://discoveredlabs.com/case-studies/granola)                                                | Map meeting-assistant buyers' scenarios and constraints to existing pages, and judge acquisition beyond visibility.                        | Help readers choose between notes, live guidance and different data-handling paths. Keep the existing blog and comparison URLs rather than creating near-duplicate articles. | This is the closest product category, but Granola's activated-user results do not predict Savvy's acquisition. A website visit or download-link click does not establish desktop activation. |
| [incident.io](https://discoveredlabs.com/case-studies/incident-io)                                        | Correct older content that conflicts with current positioning. Make answer passages understandable on their own.                           | Replace unqualified claims that Savvy always requires a CLI or bypasses its backend. Name the setup, recipients and relevant limits in the same passage.                     | Competitor-alternative content already exists in Savvy. The study gives no reason to add more without demand or performance evidence.                                                        |
| [Sova Assessment](https://discoveredlabs.com/case-studies/sova-assessment)                                | Match content to the people evaluating the product, and connect education to an appropriate next step.                                     | Frame homepage guide links around meeting decisions. Add a setup-and-pricing link beside the existing download action on every article.                                      | Savvy does not have Sova's demo-led enterprise funnel. Qualified interest must be defined for Savvy before comparing acquisition results.                                                    |
| [Anonymous B2B SaaS](https://discoveredlabs.com/case-studies/b2b-saas-4x-ai-referred-trials-aeo-strategy) | Fix content consistency, metadata and internal links before treating publishing volume as the goal.                                        | Verify article JSON-LD, canonical URLs, revision dates and internal links in the static export. Keep the existing 13 articles.                                               | The anonymous company and limited underlying data make this the least transferable study. Its publishing volume and reported trial growth are not targets for Savvy.                         |

## Implemented scope

- A homepage guide section links directly to the existing live-assistance, preparation and
  local-first comparison articles. The live-assistance article links onward to preparation,
  negotiation and data handling.
- Ten existing articles now scope personal-provider explanations explicitly or describe both
  setups. Managed processing names Deepgram and Fireworks GLM-5.3. Savvy's comparison articles
  refer readers to the pricing page for current managed prices and allowances.
- The homepage names the managed suppliers instead of making a model-performance or hosting-region
  claim. The README and `/llms.txt` also distinguish managed access from personal CLI setup.
- The live-assistance guide answers the category question in its opening paragraph and removes
  claims that a citation guarantees correctness or that other kinds of live assistance have
  no value.
- Every article's existing download panel also links to setup and pricing.
- Optional `updated` frontmatter preserves the publication date while exposing a substantive
  revision in the visible article, Open Graph metadata, JSON-LD and sitemap. Unchanged articles
  retain their publication date as their modification date.
- Export checks cover internal destinations and fragments, homepage guide links, article
  canonical URLs and structured dates. Synthetic frontmatter fixtures check revision defaults
  and invalid update dates.

The website already exports readable HTML, a sitemap, permissive robots rules, article and
application structured data, FAQ answers and `/llms.txt`. Those mechanisms are retained.
Competitor capabilities and prices in existing articles were not re-researched in this change.
Desktop behavior, supplier configuration, billing and analytics collection are unchanged.

## Measurement after publication

These are proposed checks, not measured results. Keep a dated record of the deployed commit
before evaluating the changes.

1. In Search Console, inspect the three linked guide URLs and their canonical selection.
   Compare their impressions, clicks, click-through rate and query mix over matched 28-day
   windows. Separate branded queries containing Savvy or its domain from category queries.
   Record low sample sizes and indexing delays rather than inferring an improvement.
2. Run the fixed questions below in ChatGPT, Claude, Perplexity and Google AI Overviews where
   available. Record the date, model or search mode, English locale, country, exact prompt,
   answer and cited URLs. Use fresh sessions, keep web-search settings consistent, and repeat
   each question five times. Record unavailable answers separately. Track brand mentions and
   citations to Savvy pages as separate rates with explicit denominators. Keep each engine's
   results separate. Start a new baseline if the model, questions or settings change.
3. Use existing consented website analytics to examine guide landing sessions and onward
   visits to pricing. The site does not currently establish downloads or app activation from
   those visits. Do not label them installs, activated users or purchases. Adding a new
   desktop attribution mechanism would require its own product and privacy review.
4. Where users voluntarily describe how they found Savvy in an existing feedback conversation,
   distinguish their self-report from referral data. Do not infer AI discovery from direct
   traffic. Keep any personal responses out of this public repository.

| Fixed non-branded question                                                                                            | Relevant existing page                                 |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| What is a real-time meeting assistant?                                                                                | `/blog/what-real-time-meeting-assistant-means/`        |
| I need help answering questions during a client call, not just notes afterwards. What kind of assistant should I use? | `/blog/what-real-time-meeting-assistant-means/`        |
| How should I prepare for a client meeting in 20 minutes?                                                              | `/blog/meeting-prep/`                                  |
| What should I put in a brief before a negotiation call?                                                               | `/blog/what-to-prepare-before-a-negotiation-call/`     |
| Does a local-first meeting assistant keep all audio offline?                                                          | `/blog/local-first-meeting-assistant-vs-meeting-bots/` |
| Is there an open-source meeting assistant for Mac that gives guidance from my own documents?                          | `/blog/what-real-time-meeting-assistant-means/`        |
| What should I check before choosing a bot-free meeting assistant for confidential calls?                              | `/blog/local-first-meeting-assistant-vs-meeting-bots/` |
| Can I use my own transcription and model accounts with a meeting assistant?                                           | `/blog/bring-your-own-model-claude-code-codex/`        |

The hypothesis is that direct guide links and consistent setup explanations help qualified
visitors reach the information they need. Compare the proportion of consented guide sessions
that reach pricing before and after publication, alongside search and citation observations.
Without a baseline, sufficient traffic and an activation measure, no growth claim follows.

## Work requiring more evidence

Use page-level search data to choose the next refresh or a genuinely missing topic. Do not add
one page per keyword variation, adopt a daily publishing quota, or publish original research
without collected evidence. External profiles, links and community participation need a
separate, transparent contribution plan. No external posts or outreach are part of this PR.
