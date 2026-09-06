// Every answer here has to be defensible against the app README. Nothing about
// hiding Savvy from a screen share, nothing the current build cannot do.

export const faqItems = [
  {
    question: "What do I need to run Savvy?",
    answer:
      "A Mac on macOS 13 or newer with Apple Silicon, plus a Deepgram or AssemblyAI API key for transcription. For recommendations you also need Claude Code or the Codex CLI installed on your PATH and signed in. On first launch Savvy asks for microphone and screen-recording permission; only the microphone is required to finish setup, but without system audio it hears only you.",
  },
  {
    question: "Is Savvy free?",
    answer:
      "Yes. Savvy is open source under the MIT license and there is no paid tier. You pay your own providers: a Deepgram or AssemblyAI account for transcription, and whatever plan the CLI you use for recommendations is signed in to.",
  },
  {
    question: "Where does my data go?",
    answer:
      "Your documents stay where they live. Savvy reads them read-only and never copies them, keeping derived chunks in a private local SQLite database. Meeting audio is streamed to the transcription provider you configure; there is no offline transcription in the current build. At recommendation time, selected excerpts, the brief and recent transcript turns reach the model provider your CLI is signed in to, under your own account. Provider keys sit in the macOS Keychain. Audio and transcripts are deleted after 30 days.",
  },
  {
    question: "Does it work with Zoom, Meet, Teams or phone calls?",
    answer:
      "Yes, with any app that plays audio. Savvy captures system audio through ScreenCaptureKit and your microphone separately, so nothing joins the call and no one sees an extra participant. It needs microphone and screen-recording permission to hear both sides.",
  },
  {
    question: "Is Savvy hidden from screen share?",
    answer:
      "No, and it does not try to be. Savvy is a small always-on-top panel that shows up in a screen share like any other window. It is your own notes in the room, not a disguise. Use it where AI assistance is allowed, and check the rules of your meeting first.",
  },
  {
    question: "Which languages does it handle?",
    answer:
      "Transcription language is selectable per model, and multi-language transcription is the default. The response language is a separate setting on the brief, so you can transcribe a Spanish or Catalan conversation and read the guidance in English, or the other way round.",
  },
  {
    question: "Why does Savvy sometimes say nothing?",
    answer:
      "Because it only speaks up for three reasons: the other side asked a question, someone touched a red line from your brief, or you pressed Advice. Between those it re-reads your brief and notes against the last minute of conversation and shows a Savvy noticed card only when something concrete turns up. With no recommendation CLI signed in it never thinks at all and shows a single notice instead.",
  },
  {
    question: "Does it run on Intel Macs?",
    answer:
      "Releases are Apple Silicon only, shipped as an aarch64 DMG. Intel is buildable from source but unsupported, so nothing on that path is tested.",
  },
] as const;
