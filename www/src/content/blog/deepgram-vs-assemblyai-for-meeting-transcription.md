---
title: Deepgram or AssemblyAI: picking a transcription provider for live meetings
description: Savvy needs one streaming transcription key and supports both providers. How the two compare on latency, streaming price, model choice and language handling for meeting audio.
date: 2026-09-22
tags: transcription, setup, providers
---

Savvy does not transcribe locally. It streams meeting audio to a provider you hold the key for, and it supports two: Deepgram and AssemblyAI. Setup asks for one of them before anything is transcribed, so this is the first real decision a new user makes.

Here is how we would choose, and what each option actually costs for a calendar of calls.

## What Savvy asks of a provider

The requirement is narrower than general transcription. Savvy needs streaming over a WebSocket with interim results, because guidance has to arrive while the sentence is still relevant. Accuracy on entity-shaped words matters, product names, numbers, company names, since those are what a recommendation card gets checked against. Batch accuracy, speaker diarization quality and file-upload workflows do not matter here at all.

The models Savvy exposes in Settings map straight onto that:

- **Deepgram:** `nova-3` (the default), plus `nova-3-medical`, `nova-2`, and the `nova-2` conversational, medical and phone-call variants.
- **AssemblyAI:** `u3-rt-pro`, `universal-streaming-english`, and `universal-streaming-multilingual`.

## The practical differences

**Latency.** Both are in the sub-second band for streaming, which is the only band that works for live guidance. Deepgram publishes end-to-end streaming latency in the 200 to 300 millisecond range for Nova-3 in good conditions; AssemblyAI's realtime models are advertised in the same territory. Neither is a bottleneck compared to the time a model takes to compose a recommendation.

**Streaming price.** This is where they visibly differ. At rates published during 2026, Deepgram Nova-3 streaming was around $0.0077 per minute, roughly $0.46 per audio hour. AssemblyAI's Universal-Streaming tier was $0.15 per hour for English and multilingual, with the heavier Universal-3.5 Pro Realtime model at $0.45 per hour base.

Put that against a working week: five hours of calls is somewhere between about $0.75 and $2.30 of transcription, depending on which model you pick. Transcription is not the expensive part of this setup, and it is not worth optimising before you know whether you like the product. Check both pricing pages before you commit anything, because several of these numbers moved during 2026.

**Language handling.** AssemblyAI's `universal-streaming-multilingual` is the straightforward answer for calls that switch languages. Savvy also sends a language prompt to `u3-rt-pro` for English, Spanish, French, German, Italian and Portuguese, which helps when a model would otherwise drift. Deepgram carries a wider set of specialised models, so if your calls are consistently one domain, a `nova` variant tuned for phone audio or medical vocabulary can beat a general model.

**Domain models.** Deepgram is the one with a menu. If you take clinical calls, `nova-3-medical` exists; if the audio arrives over a phone line, `nova-2-phonecall` exists. AssemblyAI's approach is fewer models with more configuration.

## The part that is not about accuracy

Audio is the most sensitive thing Savvy touches, and choosing a provider is choosing who hears your meetings.

Savvy sets Deepgram's `mip_opt_out=true` on every streaming connection, so audio sent through Savvy is not used to improve their models. If you pick AssemblyAI, check their current terms for the equivalent, because Savvy cannot set a flag that does not exist in their API. Either way the audio is leaving your Mac, under your key, on your account, and there is no offline transcription mode in the current build. If that is unacceptable for a particular conversation, the answer is not to start the meeting in Savvy.

Everything else stays local: source documents are referenced read-only and never copied, derived chunks and indexes live in a private SQLite database, and local audio and transcripts are deleted after 30 days with cleanup at startup. Keys sit in the macOS Keychain and only ever leave as an Authorization header. The [privacy section](/#privacy) has the whole flow, and [Local-first meeting assistants vs bots that join the call](/blog/local-first-meeting-assistant-vs-meeting-bots/) explains why we draw that line where we do.

## How we would actually choose

- **Default, English calls, no strong opinion:** Deepgram `nova-3`. It is the default because it behaves well on meeting audio out of the box.
- **Cheapest streaming, or calls that mix languages:** AssemblyAI `universal-streaming-multilingual`.
- **Phone-heavy or clinical vocabulary:** the matching Deepgram `nova` variant beats a general model by more than the price difference.
- **Already paying one of them for something else:** use that one. A second vendor relationship is not worth a rounding error on a per-hour rate.

You can change providers in Settings later. Nothing in your briefs or history is tied to the choice, so pick one and start.
