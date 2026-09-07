---
title: Local-first meeting assistants vs bots that join the call
description: How a local-first, bring-your-own-model assistant like Savvy differs from a meeting bot: who is in the call, where audio goes, who pays, and what you give up.
date: 2026-09-06
tags: comparison, local-first, privacy
---

A meeting bot is a hosted service that joins your call as a participant, records everyone, and sends the recording to the vendor's cloud. A local-first meeting assistant runs on your own machine, listens through your own audio, and keeps your documents where they already are. Savvy is the second kind. This post lays out the difference plainly, including the parts where the bot model is the better fit.

## What a meeting bot does

The hosted-bot category covers most of the "AI notetaker" products you have seen appear in a Zoom or Meet call. The shape is the same across vendors:

- A bot account joins the meeting. Everyone on the call sees it in the participant list.
- It records audio and often video for the whole call.
- The recording is uploaded to the vendor, transcribed and summarised there, and stored under the vendor's retention policy.
- The output is a shared record: transcript, summary, action items, sometimes a CRM update.
- The vendor's model is bundled into the price. You do not choose it, and the data-handling terms are the vendor's.

The strength of this model is the shared record. The whole team can search past calls. Admins can set retention. Nobody has to install anything on their laptop.

## What a local-first assistant does

Savvy is a macOS application. Nothing joins the call. It captures your microphone and the system audio of whatever app is playing the other side, so it works with Zoom, Meet, Teams, or a phone call routed through your Mac. See the [FAQ](/#faq) for the permissions it needs.

Before the call it reads the documents you point it at, read-only, and builds a brief. During the call it listens and shows a small always-on-top panel with a suggestion when there is a reason to: the other side asked a question, someone touched a red line from your brief, or you asked for advice. Each card says what to say, what to avoid, and which file says so. The details of that logic are in [How Savvy decides when to speak](/blog/when-savvy-speaks-up/).

The output is guidance for one person, live. It is not a team record.

## Where the audio goes

This is the part where "local-first" needs qualifying, and we would rather do it here than in a footnote.

Savvy keeps your source documents, derived indexes, brief, audio files and transcripts on your Mac. But live transcription is not local. Meeting audio is streamed to Deepgram or AssemblyAI, using your own account, as it is captured. There is no offline transcription mode in the current build. Savvy sets Deepgram's `mip_opt_out=true` so your audio is not used to train their models; you should check AssemblyAI's terms for the equivalent.

At recommendation time, selected excerpts from your documents, the brief, and recent transcript turns are sent to the model provider that your CLI is signed in to. Whole documents never leave the machine.

Audio and transcripts are deleted after 30 days. Provider keys sit in the macOS Keychain. The full table is on the [privacy section](/#privacy) of the homepage.

So the honest comparison is not "cloud vs no cloud". It is "one vendor holds the recording, the transcript and the summary under their terms" versus "your transcription provider hears the audio, your model provider sees excerpts, and the files stay with you".

## Who runs the model

A meeting bot ships with a model. You get whatever the vendor picked, priced into the seat.

Savvy has no model of its own. It shells out to Claude Code or the Codex CLI already installed and signed in on your Mac, so recommendations bill to the plan you have and run under the terms you already agreed to. That is convenient if you already pay for one of those. It is a setup step if you do not. [Bring your own model](/blog/bring-your-own-model-claude-code-codex/) covers the cost and data-flow side in detail.

## Who pays

Bots are usually priced per seat per month, with a free tier that limits minutes or features.

Savvy is free and MIT-licensed. There is no paid tier. You pay your own providers: a Deepgram or AssemblyAI account for transcription, billed per audio minute at their rates, and whatever plan your CLI is on for recommendations.

## What you give up with Savvy

The tradeoffs are real, and they are the reason a team might still pick a bot:

- **No shared record.** Savvy is built for one person on one Mac. It does not publish a transcript to the team or write to a CRM.
- **You carry the consent conversation.** No bot appears in the participant list, so nobody is told automatically that a transcript exists. That is on you. [Recording a meeting: consent and etiquette](/blog/meeting-recording-consent-and-etiquette/) has the wording we suggest.
- **Two accounts to set up.** A transcription key and a signed-in CLI, before the first recommendation.
- **Apple Silicon Macs on macOS 13 or newer.** Intel builds are possible from source but unsupported. No Windows, no Linux, no mobile.
- **Audio still leaves the machine** for transcription, as described above.

## What you give up with a bot

- **Everyone sees it,** and some people change how they talk when a recorder is in the room.
- **The vendor holds the data.** Retention, training use, and subprocessors are their decisions, and they can change.
- **It works after the call, not during it.** Most bots produce a summary once the meeting ends. If the value you want is knowing what to say while the other side is still talking, a post-call summary does not give you that.
- **It cannot read your files.** A bot knows what was said in the meeting. It does not know that your pricing sheet says the discount needs approval.

## Which one fits

Pick a bot if the goal is a searchable archive of every call for a team, and the people on those calls are fine being recorded by a third party.

Pick Savvy if the goal is to walk into one call better prepared and get grounded, in-the-moment guidance from your own documents, on your own hardware, without a subscription. Read the [privacy section](/#privacy) first, then decide whether streaming audio to a transcription provider under your own account is acceptable for the calls you have in mind.

They are not exclusive. Some people run a bot for the record and Savvy for the call.
