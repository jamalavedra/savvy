export const faqItems = [
  {
    question: "What do I need to run Savvy?",
    answer:
      "An Apple Silicon Mac running macOS 13 or newer, a Deepgram or AssemblyAI API key, and Claude Code or Codex CLI installed and signed in. Allow microphone access to hear you and screen-recording access to capture system audio.",
  },
  {
    question: "Does Savvy join the call as a bot?",
    answer:
      "No. Nothing appears in the participant list. Savvy captures your microphone and the audio your Mac is already playing, so the other side sees no attendee and no recording notice. That also means nobody is told automatically that a transcript exists, so disclosing it is your job.",
  },
  {
    question: "Is Savvy free?",
    answer:
      "The open-source app is free under the MIT license. You pay your own transcription and model providers for their services.",
  },
  {
    question: "Where does my data go?",
    answer:
      "Source files stay in their folders. Savvy stores extracted text, indexes, briefs, recordings, and transcripts on your Mac. Audio streams to your transcription provider. Savvy sends selected excerpts, the whole brief and recent transcript turns to your CLI's model provider. Savvy stores transcription keys in macOS Keychain. At startup, Savvy deletes local recordings and transcripts older than 30 days.",
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
