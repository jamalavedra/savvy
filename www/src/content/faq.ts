export const faqItems = [
  {
    question: "Do I need to buy a plan to create an account?",
    answer:
      "No. Create an account or sign in with Google or an emailed six-digit code. You can explore local history and meeting preparation without purchasing managed allowance. Checkout is a separate step.",
  },
  {
    question: "What happens during an audio check?",
    answer:
      "Signal checks use local capture. An explicitly started transcription test sends audio to your selected provider for up to 30 seconds. Managed tests use meeting allowance. Skipping a test does not mark transcription as working, and no check starts a meeting automatically.",
  },
  {
    question: "What do I need to run Savvy?",
    answer:
      "An Apple Silicon Mac running macOS 13 or newer, either personal providers or a Savvy managed account. Personal setup needs a Deepgram or AssemblyAI API key and Claude Code or Codex CLI installed and signed in. Allow microphone access to hear you and optional system-audio access to hear the other participants. Microphone-only mode is available.",
  },
  {
    question: "Does Savvy join the call as a bot?",
    answer:
      "No. Nothing appears in the participant list. Savvy captures your microphone and the audio your Mac is already playing, so the other side sees no attendee and no recording notice. That also means nobody is told automatically that a transcript exists, so disclosing it is your job.",
  },
  {
    question: "Is Savvy free?",
    answer:
      "The open-source app is free under the MIT license. You can pay your own transcription and model providers, or choose optional managed assistance in the same app. See the pricing page for managed offers.",
  },
  {
    question: "Where does my data go?",
    answer:
      "Source files stay in their folders. Savvy stores extracted text, indexes, briefs, recordings, and transcripts on your Mac. Audio streams to your transcription provider. Savvy sends selected excerpts, the whole brief and recent transcript turns to your CLI's model provider. With managed assistance, audio passes through Savvy to Deepgram and selected context passes through Savvy to Claude. Savvy stores provider keys and managed credentials in macOS Keychain. At startup, Savvy deletes local recordings and transcripts older than 30 days.",
  },
  {
    question: "Does it work with Zoom, Meet, Teams or phone calls?",
    answer:
      "Savvy captures audio played by apps on your Mac, plus your microphone. It does not join the call as a participant. Calls on another device are not captured unless their audio reaches your Mac.",
  },
  {
    question: "Does Savvy work for in-person meetings?",
    answer:
      "Yes. Your microphone captures the room, so a table conversation works the same way as a video call. Savvy still needs an internet connection, because transcription streams to your provider and recommendations run through your CLI.",
  },
  {
    question: "How is Savvy different from Granola, Otter or Fireflies?",
    answer:
      "Those tools produce a record after the call, and Otter and Fireflies send a bot to capture it. Savvy is for during the call: it reads your own documents beforehand and surfaces what to say, what to avoid, and which file says so, while the conversation is still happening. It has no shared team archive and no CRM writeback.",
  },
  {
    question: "Is Savvy hidden from screen share?",
    answer:
      "No. The panel can appear when you share your screen, like other windows. Follow the rules of your meeting when using AI assistance.",
  },
  {
    question: "Which languages does it handle?",
    answer:
      "Available transcription languages depend on the provider and model you select. The response language is a separate setting on your brief, so guidance can use a different language from the conversation.",
  },
  {
    question: "When does Savvy offer guidance?",
    answer:
      "Savvy responds to questions, flags constraints from your brief, and offers advice when you press Advice. It also checks recent conversation for relevant changes. Guidance requires a configured recommendation provider.",
  },
  {
    question: "Does it run on Intel Macs?",
    answer: "Release downloads support Apple Silicon. Intel builds from source are unsupported.",
  },
] as const;
