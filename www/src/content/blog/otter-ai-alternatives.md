---
title: Otter.ai alternatives: pick by what you are replacing
description: Otter does three jobs: live captions, a searchable archive, and post-call summaries. Pick an alternative by the one you use. With prices for each.
date: 2026-09-22
updated: 2026-10-29
tags: comparison, meeting-assistant, privacy
---

Otter.ai bundles three things that people treat as one product:

1. A live, word-for-word transcript and captions while the call happens.
2. A searchable archive of every meeting, queryable after the fact.
3. Post-call summaries and action items.

Most people who want to leave only use one of the three. Work out which, and the replacement is obvious. Pick by "best overall" and you will end up with something that drops the part you relied on.

## If you use Otter for live captions

Keep it, or look at accessibility tooling rather than the meeting-assistant category. Otter is unusual in typing the conversation out in real time; Granola, Fireflies and Fathom are not built for that, and neither is Savvy. Savvy shows short guidance cards, not a running transcript.

## If you use Otter for the team archive

You want another bot-based product, because the archive comes from a participant joining every scheduled call and the vendor storing it. Fireflies is the usual move for CRM automation and broad language coverage; Fathom is the usual move for cost. Both keep the shape of what Otter does: something joins, the vendor holds the record, the team searches it.

Bot-free tools cannot replace this, and any list that tells you otherwise is selling you something. Savvy included: it is a single-person Mac app with no shared archive.

## If you use Otter for post-call summaries

This is the crowded part of the market and almost everything competes here. The real decision is whether you still want a bot in the call. Granola captures desktop audio with nothing joining, which also covers in-person meetings and phone calls, and produces notes afterwards.

## If what you actually wanted was help during the call

Otter's own answer to this is a real-time meeting agent, and at time of writing it sits on the higher tiers. If that is the feature you are paying the subscription for, it is worth naming what you want from it, because "real time" covers two very different products:

- **Real-time transcript.** Text of what was just said. Useful, and Otter is strong at it.
- **Real-time guidance.** A suggestion about what to say next, grounded in something other than the conversation itself.

Savvy is the second kind, and only the second kind. Before the call it reads documents you point it at, read-only, and builds a brief. During the call it surfaces a card when the other side asks a question, when someone touches a red line from your brief, or when you press Advice, and every card cites the file behind it. There is more on the triggers in [How Savvy decides when to speak](/blog/when-savvy-speaks-up/), and on the wider distinction in [What "real-time meeting assistant" actually means](/blog/what-real-time-meeting-assistant-means/). If you were also looking at on-screen overlays like Cluely, [Cluely alternatives for work meetings](/blog/cluely-alternatives/) compares them.

## The cost and data comparison people skip

Otter prices a bundle: transcription, storage, and its own model, per seat per month, with a free tier that caps minutes and per-meeting length.

Savvy's personal-provider setup separates the app from provider access:

- **The app** is free and MIT-licensed. No tier, no seats.
- **Transcription** is your own Deepgram or AssemblyAI key, billed per audio minute by them. See [Deepgram or AssemblyAI](/blog/deepgram-vs-assemblyai-for-meeting-transcription/).
- **The model** is whatever Claude Code or Codex CLI is signed in to on your Mac, billed on your existing plan. See [Bring your own model](/blog/bring-your-own-model-claude-code-codex/).

Personal setup needs a transcription key and a signed-in CLI. Optional paid managed assistance needs neither: audio passes through Savvy to Deepgram and selected brief evidence and meeting context through Savvy to Fireworks GLM-5.3. [Compare setup and pricing](/pricing/) and read the [privacy policy](/privacy/) before choosing.

On data: with Otter, the vendor holds the recording, the transcript, and the summary under its terms. With Savvy's personal-provider setup, your transcription provider receives the audio under your key, your model provider sees excerpts and recent turns under your plan, and the files stay on your Mac with local audio and transcripts deleted after 30 days. Neither is "private" in the absolute sense. They put the trust in different places, and the [privacy section](/#privacy) shows exactly where ours goes.

## One thing to settle before you switch away from a bot

A bot in the participant list tells everyone a recording exists. Bot-free capture does not, so the disclosure becomes your job. It is a two-sentence habit, and [Recording a meeting: consent and etiquette](/blog/meeting-recording-consent-and-etiquette/) has the wording, along with the reason it matters more in all-party consent jurisdictions.

## What each one costs

List prices in USD, per user, as published on each vendor's pricing page in October 2026. Check before you buy; these change.

- **Otter:** Basic is free with 300 transcription minutes a month and 30 minutes per conversation. Pro lists at $16.99 a month or $8.33 a month billed annually, with 1,200 minutes and 90 minutes per conversation. Business is $30 a month or $19.99 billed annually, with unlimited meeting minutes. Otter was running a discount on Pro when we checked. Source: [otter.ai/pricing](https://otter.ai/pricing).
- **Fathom:** Free with unlimited recordings. Premium is $20 a month or $16 billed annually; Team is $19 a month or $15 billed annually, for two users or more. Bot-free capture is a Mac beta. Source: [fathom.ai/pricing](https://www.fathom.ai/pricing).
- **Fireflies:** a free tier and per-seat Pro and Business plans. The pricing page did not show figures when we checked, so look there directly: [fireflies.ai/pricing](https://fireflies.ai/pricing).
- **Granola:** Basic is free with 30 days of meeting history. Business is $14 a month. Source: [granola.ai/pricing](https://www.granola.ai/pricing).
- **Savvy:** the app is free and MIT-licensed. With your own providers you pay Deepgram or AssemblyAI per audio minute and use the Claude Code or Codex plan you already have. Optional paid managed assistance handles provider access. See current allowances and prices on the [pricing page](/pricing/).

## Questions people ask

### Is there a free Otter alternative?

Fathom's free plan has unlimited recordings, which is more than Otter's 300 minutes. Granola's free plan keeps 30 days of history. Savvy is free to install, but you pay your transcription provider per minute unless you use the managed plan.

### Is there an Otter alternative without a bot?

Granola and Savvy both capture audio on your computer, so nothing joins the call. Fathom has bot-free capture in beta on Mac. Without a bot, telling the other side you are recording is up to you.

### Is there an open-source Otter alternative?

Savvy is MIT-licensed and the [source is on GitHub](https://github.com/jamalavedra/savvy). It replaces Otter's live features with guidance, not with a transcript, so it is not a like-for-like swap.
