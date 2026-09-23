---
title: What "real-time meeting assistant" actually means
description: Four different products are sold as real-time meeting assistants: live transcripts, live summaries, generic conversation coaching, and guidance grounded in your own documents. They are not substitutes.
date: 2026-09-22
tags: meeting-assistant, real-time, comparison
---

"Real-time meeting assistant" and "AI meeting coach" are used for at least four products that behave nothing alike in a call. If you are shopping in this category, the fastest way to avoid buying the wrong one is to ask what the live output is made of.

## Type 1: a live transcript

Text of what was just said, on screen, as it is said. Otter is the well-known version. This is genuinely real-time and genuinely useful, for accessibility, for people who lose the thread, for anyone who needs to quote a sentence back accurately.

It does not tell you anything. Reading a transcript of a question while being asked the question is not help; it is the same problem with extra text.

## Type 2: a live summary or scratchpad

Some bot-based tools show a running summary during the call, or give you a notepad on the desktop app. Fathom does a version of this. It reduces the note-taking load while you talk, which is real value.

What it does not do is retrieve anything. The summary is a compression of the conversation you are already in.

## Type 3: generic conversation coaching

Prompts that come from the shape of the conversation rather than its content: you have been talking for four minutes, ask an open question, they raised an objection, here is an objection-handling frame. Sales-coaching products have done this for years, and the newer general-purpose "answer anything on your screen" assistants are a variant of it.

This is useful when the skill is the gap. It is useless when the gap is a fact, because a model that knows nothing about your business will produce a confident, plausible, wrong number.

## Type 4: guidance grounded in your own material

The live output is a claim retrieved from documents you chose, with the document named. This is the category Savvy is in, and the one with the fewest products in it, because it requires work before the call rather than a clever prompt during it.

The workflow, concretely:

- Before the call, you point Savvy at a folder. It reads the files read-only and builds a brief: the positions, the constraints, the red lines. Preparation can be scoped to one client or kept general.
- During the call, the overlay switches to thinking for three reasons: the other side asked a question, someone touched a hard constraint from your brief, or you pressed Advice. Between those it periodically re-reads the brief against the last minute of conversation and raises a card only if it finds something concrete.
- Each card says what to say, what to avoid, and which file says so, so you can decide in two seconds whether to trust it.

[How Savvy decides when to speak](/blog/when-savvy-speaks-up/) documents the triggers in detail, including the case where it stays quiet.

## Why the distinction decides your purchase

Consider a renewal call where the buyer asks for 25% off a three-year commitment.

- The live transcript shows you the words "twenty five percent".
- The live summary notes that pricing was discussed.
- The generic coach suggests you anchor high and ask about their timeline.
- A document-grounded assistant says your pricing sheet caps discretionary discount at 15%, anything beyond that needs finance approval, and here is the file.

Only the last one changes what you say. And only the last one can be wrong in a way you can immediately check, which is the property that makes live AI usable at all: a card that cites a file is a card you can dismiss in a glance when it has misread the file.

## What live guidance costs you

Every product in types 3 and 4 has the same two problems, and you should ask about both.

**Attention.** A card is worth reading only if it is rare. Savvy's answer is to think on three triggers and stay quiet otherwise, and to say nothing at all when no recommendation CLI is signed in rather than filling the space.

**Latency and where audio goes.** Live guidance needs a live transcript, which means audio leaves your machine as it is captured. Savvy streams it to your own Deepgram or AssemblyAI account, with no offline mode in the current build, and sends selected excerpts plus recent turns to whichever provider your CLI uses. That is the trade for guidance during the call rather than after it, and the [privacy section](/#privacy) draws it in full.

## If you are comparing options

Ask each vendor one question: where does the live suggestion come from? If the answer is "the conversation", you are buying type 1, 2 or 3, and those are fine products for the jobs they do. If the answer is "your documents", ask to see a card that names the file.

[Savvy](/) is free and MIT-licensed, for Apple Silicon Macs on macOS 13 or newer. Nothing joins the call.
