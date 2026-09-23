---
title: Claude Code and Codex CLI use cases that are not coding
description: A coding CLI signed in on your machine is a general-purpose local model runtime with a shell interface. What that unlocks outside the editor, and what we learned using one as a meeting assistant's engine.
date: 2026-09-22
tags: Claude Code, Codex CLI, bring your own model, architecture
---

Claude Code and the Codex CLI are sold as coding agents, and most write-ups treat them that way: refactors, test generation, bug hunts. But what you actually have, once one of them is installed and signed in, is a model you can invoke from a shell, on a machine that holds your files, billed to a plan you already pay for.

That is a runtime, and the interesting use cases are the ones that have nothing to do with source code. We built one of them, so this is partly a field report.

## The shape of the opportunity

Three properties matter, and they are easy to miss because the marketing talks about programming:

1. **It is local.** The CLI runs on your machine, so it can be handed content that never goes into a browser tab.
2. **It is already authenticated.** No API key management, no separate billing relationship, no key in a `.env` file for a desktop app to leak.
3. **It is a process.** Anything that can spawn a subprocess can use a frontier model, which is a much lower bar than an SDK integration.

The consequence for anyone building a desktop app: you can ship a model-powered product without becoming a model reseller. You do not mark up tokens, you do not hold a vendor key for thousands of users, and you do not have to explain your inference costs in your pricing page, because you have none.

## Non-coding use cases that work well

**Document interrogation over a folder.** Point the CLI at a directory and ask questions that span files. This is what everyone reaches for first, and it holds up: the model reads what it needs rather than you pre-chunking everything into a vector store.

**Repeated structured extraction.** Invoices, contracts, exports from a system with no usable API. A shell loop plus a prompt plus a JSON schema replaces a week of parser work, and the failure mode is visible rather than silent.

**Local file operations described in prose.** Renaming, reorganising, reconciling two directories that should match. The CLI's file tools were built for source trees and work identically on a folder of PDFs.

**Personal automation that needs judgement.** Triage, drafting, summarising a week of notes. The part that was previously hard is not the automation, it is the one decision in the middle that needed a human, and that is exactly the part a model handles.

**An assistant's reasoning engine.** This is ours. [Savvy](/) is a macOS meeting assistant that prepares a brief from your own documents, then offers guidance during a live conversation. It has no model of its own: it shells out to Claude Code or the Codex CLI, so excerpts and recent transcript turns reach whichever provider that CLI is signed in to, under your account and its terms.

## What we learned running a CLI as an app's engine

**It changes your pricing model, not just your bill.** Savvy is free and MIT-licensed, and that is possible because there is no inference cost to recover. Users pay their providers directly: a transcription key, and whatever plan their CLI is on. The full accounting is in [Bring your own model](/blog/bring-your-own-model-claude-code-codex/).

**Provider status becomes a first-class UI state.** If no CLI is signed in, there is no model. Savvy checks for `codex` or `claude` on the `PATH`, reports provider status in Settings, and refuses to pretend: with no recommendation CLI signed in it never thinks during a meeting, it shows one notice instead. Any app built this way needs that state designed, not handled as an error.

**Latency is the real constraint, not cost.** For a live conversation, a recommendation that arrives after the moment has passed is worth nothing. That shaped the product more than any prompt: Savvy composes on three explicit triggers rather than continuously, and says which reason it is working on while it composes. [How Savvy decides when to speak](/blog/when-savvy-speaks-up/) is mostly a latency document wearing a UX hat.

**Send excerpts, not everything.** It is tempting to hand the model the whole folder, because it can take it. Selected excerpts plus the brief plus recent turns is both faster and a far easier data-flow story to write down honestly. Ours is in the [privacy section](/#privacy).

**Two CLIs, one interface.** Supporting both Claude Code and the Codex CLI cost us less than expected and removed a single point of failure, since users arrive already committed to one vendor or the other.

## Where it does not fit

Be honest about the limits before you build on this pattern.

- **It needs a setup step.** The user installs a CLI and signs in before anything works. For a consumer product that is a wall; for a developer-adjacent tool it is a Tuesday.
- **It is desktop-only.** There is no shelling out from a web app or a phone.
- **You inherit someone else's rate limits.** When the user's plan throttles, your product throttles, and you did not get a warning.
- **You do not control the model.** The CLI updates, behaviour shifts, and your prompts were tuned against the old version.

None of these are dealbreakers for a local-first desktop tool. All of them are dealbreakers for a hosted service, which is roughly the line this pattern draws.

## Try the pattern

The fastest way to feel it is to run a coding CLI against a folder that has no code in it, and ask something that requires reading three files at once. If you want to see it wired into a product, [Savvy](/) is on GitHub under MIT, and the parts that call the CLI are a small, readable slice of the repo.
