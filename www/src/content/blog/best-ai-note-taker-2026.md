---
title: The best AI note taker depends on one question: bot or no bot
description: An honest comparison of AI note takers and meeting assistants in 2026, grouped by architecture rather than feature count: bot or bot-free, post-call or in-call, vendor model or your own.
date: 2026-09-22
tags: comparison, meeting-assistant, privacy
---

Every "best AI note taker" list is the same nine products in a different order. The ordering rarely matters, because the products differ on two structural choices that decide whether a tool fits your calls at all:

1. Does something join the meeting, or does the app listen on your machine?
2. Does the help arrive after the call, or during it?

Answer those two and the shortlist writes itself. Everything else, template libraries, CRM fields, talk-time charts, is detail you can evaluate afterwards.

Savvy is one of the products below, so read this as a comparison written by an interested party. The architecture claims are checkable, and we say plainly where another tool is the better choice.

## Question one: does a bot join the call?

**Bot-based.** Otter, Fireflies and Fathom send a participant into scheduled video calls. Everyone sees it in the attendee list. The vendor records, uploads, transcribes and stores the call under its own retention policy. This is the simplest way to capture audio from any platform, and it gives a team one shared, searchable archive.

**Bot-free.** Granola and Savvy capture the system audio already playing on your Mac, plus your microphone. Nothing joins the call, nothing appears in the participant list, and the same capture works for an in-person conversation or a phone call routed through the machine.

The practical consequences of that choice:

- A bot makes the recording visible, which is useful when you want everyone to know a transcript exists, and awkward when a visible recorder changes how the other side talks.
- Bot-free capture works where a bot cannot go: a room, a phone, a platform that blocks unknown participants.
- Bot-free capture puts the consent conversation on you, because nobody is notified automatically. We wrote up the wording we use in [Recording a meeting: consent and etiquette](/blog/meeting-recording-consent-and-etiquette/).

## Question two: after the call, or during it?

Almost all of this category is post-call. Fireflies and Fathom produce their summary once the meeting ends. Granola is bot-free but still notes-first: it captures audio and cleans up the bullets you typed, rather than running a live transcript. Otter is the exception on live text, it types a real-time transcript and captions during the call, and its newer real-time meeting agent is gated to higher tiers.

A post-call summary is the right product if the value you want is a record. It cannot help with the sentence you have to say in eleven seconds.

The in-call tools are a smaller group, and they split again by what the live help is made of. Some read only the conversation, which makes them good at generic prompts and useless on your specifics. Savvy reads a brief built from your own documents first, so a card during the call can say the discount needs approval above 15% because that is what your pricing sheet says, and show you the file. [How Savvy decides when to speak](/blog/when-savvy-speaks-up/) covers the triggers.

## Question three, for a smaller audience: whose model runs it?

Bots bundle a model into the seat price. You get the vendor's choice, and the data-handling terms are the vendor's.

Savvy has no model of its own. It shells out to the Claude Code or Codex CLI already installed and signed in on your Mac, so recommendations bill to the plan you already pay for and run under terms you already accepted. Convenient if you have one, a setup step if you do not. [Bring your own model](/blog/bring-your-own-model-claude-code-codex/) has the cost and data-flow detail.

## So which one

**Pick a bot-based tool** (Otter, Fireflies, Fathom) if you want an archive of every call that a team can search, CRM writeback, and an admin who controls retention. Fathom has the most generous free tier of the three. Fireflies is the one people choose for CRM automation and wide language coverage. Otter is the one to pick if live captions on screen are the point.

**Pick Granola** if you want bot-free capture on Mac or Windows, you like typing your own bullets and having them cleaned up, and post-call notes are all you need.

**Pick Savvy** if the hard part of your calls is what to say while the other side is still talking, the answer lives in documents you already have, and you would rather run the model on your own account than rent one. It is a single-person Mac app, free and MIT-licensed, with no team archive and no CRM.

**Pick two.** Several people we talk to run a bot for the record and Savvy for the conversation. They do not conflict; the bot is in the call, Savvy is on the laptop.

## What to check before you commit to any of them

- Where the audio goes, and under whose account. "Local-first" is not the same as offline. Savvy keeps documents, briefs and transcripts on your Mac but streams meeting audio to Deepgram or AssemblyAI under your own key. Our [privacy section](/#privacy) draws the whole flow.
- How long recordings are kept, and whether you can shorten it. Savvy deletes local audio and transcripts after 30 days.
- Whether the tool works for the calls you actually have. Half of many people's important conversations are in a room or on a phone, where a meeting bot cannot follow.
- What happens on the pricing page in a year. A free tier that limits minutes is a different commitment from an MIT licence.

Pricing in this category moved several times in 2026, so check the vendor's own page rather than any roundup, including this one. The architecture is the part that does not change quietly.
