export const faqItems = [
  {
    question: "What do I need to run Savvy?",
    answer:
      "An Apple Silicon Mac running macOS 13 or newer, a Deepgram or AssemblyAI API key, and Claude Code or Codex CLI installed and signed in. Allow microphone access to hear you and screen-recording access to capture system audio.",
  },
  {
    question: "Is Savvy free?",
    answer:
      "The open-source app is free under the MIT license. You pay your own transcription and model providers for their services.",
  },
  {
    question: "Where does my data go?",
    answer:
      "Source files stay in their folders. Extracted text, indexes, briefs, recordings, and transcripts are stored locally. Audio streams to your transcription provider. AI tasks send selected excerpts and relevant context to the provider your CLI uses. Transcription keys are stored in the macOS Keychain. Local recordings and transcripts older than 30 days are removed when Savvy starts.",
  },
  {
    question: "Does it work with Zoom, Meet, Teams or phone calls?",
    answer:
      "Savvy captures audio played by apps on your Mac, plus your microphone. It does not join the call as a participant. Calls on another device are not captured unless their audio reaches your Mac.",
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
    answer:
      "Release downloads support Apple Silicon. Intel builds from source are unsupported and untested.",
  },
] as const;
