---
title: What "real-time meeting assistant" actually means
description: Four different products are sold as real-time meeting assistants: live transcripts, live summaries, generic conversation coaching, and guidance grounded in your own documents. They are not substitutes.
date: 2026-09-22
updated: 2026-10-29
tags: meeting-assistant, real-time, comparison
---

A real-time meeting assistant provides output while a conversation is happening. That output may be a transcript, a summary, coaching or guidance from your documents. Choose by what you need to do during the call. Savvy provides document-grounded guidance on Apple Silicon Macs running macOS 13 or newer, with no bot joining the meeting.

## Type 1: a live transcript

Text of what was just said, on screen, as it is said. Otter is the well-known version. This is useful for accessibility, for people who lose the thread, for anyone who needs to quote a sentence back accurately.

A live transcript helps you follow or quote the conversation. It does not, by itself, check the answer against your pricing sheet or contract.

## Type 2: a live summary or scratchpad

Some bot-based tools show a running summary during the call, or give you a notepad on the desktop app. Fathom does a version of this. It reduces the note-taking load while you talk, which is real value.

What it does not do is retrieve anything. The summary is a compression of the conversation you are already in.

## Type 3: generic conversation coaching

Prompts that come from the shape of the conversation rather than its content: you have been talking for four minutes, ask an open question, they raised an objection, here is an objection-handling frame. Sales-coaching products have done this for years, and the newer general-purpose "answer anything on your screen" assistants are a variant of it. [Cluely alternatives for work meetings](/blog/cluely-alternatives/) compares the best-known of those.

Coaching can help you handle an objection. For a business-specific fact, ask what evidence supports the suggestion and whether you can inspect it.

## Type 4: guidance grounded in your own material

The live output is a claim retrieved from documents you chose, with the document named. This is the category Savvy is in, and the one with the fewest products in it, because it requires work before the call rather than a clever prompt during it.

The workflow, concretely:

- Before the call, you point Savvy at a folder. It reads the files read-only and builds a brief: the positions, the constraints, the red lines. Preparation can be scoped to one client or kept general.
- During the call, the overlay switches to thinking for three reasons: the other side asked a question, someone touched a hard constraint from your brief, or you pressed Advice. Between those it periodically re-reads the brief against the last minute of conversation and raises a card only if it finds something concrete.
- Cards show what to say, what to avoid and the supporting source when one is available. Check that source before making a commitment.

[How Savvy decides when to speak](/blog/when-savvy-speaks-up/) documents the triggers in detail, including the case where it stays quiet.

## Why the distinction decides your purchase

Consider a renewal call where the buyer asks for 25% off a three-year commitment.

- The live transcript shows you the words "twenty five percent".
- The live summary notes that pricing was discussed.
- The generic coach suggests you anchor high and ask about their timeline.
- A document-grounded assistant says your pricing sheet caps discretionary discount at 15%, anything beyond that needs finance approval, and here is the file.

In this fictional example, document-grounded guidance lets you check the discount against the pricing sheet. A citation makes the suggestion easier to verify; it does not guarantee that the model read the file correctly.

## What live guidance costs you

Every product in types 3 and 4 has the same two problems, and you should ask about both.

**Attention.** Savvy uses the triggers and background scan described above. In personal-provider mode, an unavailable recommendation CLI produces a notice instead of repeated model requests.

**Latency and where audio goes.** Savvy has no offline transcription mode. With personal providers, audio goes to your Deepgram or AssemblyAI account, and selected excerpts, the whole brief and recent relevant transcript turns go to your signed-in CLI's provider. With managed assistance, audio passes through Savvy to Deepgram and selected context through Savvy to Fireworks GLM-5.3. Local audio and transcripts are deleted after 30 days, with cleanup at startup. Read the [privacy policy](/privacy/) for both paths.

## If you are comparing options

Ask each vendor one question: where does the live suggestion come from? If the answer is "the conversation", you are buying type 1, 2 or 3, and those are fine products for the jobs they do. If the answer is "your documents", ask to see a card that names the file.

For a client meeting, start with the [20-minute preparation checklist](/blog/meeting-prep/). For a renewal or negotiation, use the [brief with positions and red lines](/blog/what-to-prepare-before-a-negotiation-call/). If your main concern is data handling, compare [local-first assistants and meeting bots](/blog/local-first-meeting-assistant-vs-meeting-bots/).

[Savvy](/) is free and MIT-licensed. Personal providers require your own transcription key and a signed-in Claude Code or Codex CLI. Optional paid managed assistance handles provider access without your own keys or CLI. [Compare setup and pricing](/pricing/) before downloading.
