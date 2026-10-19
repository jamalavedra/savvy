export const faqItems = [
  {
    question: "Does Savvy join the call as a bot?",
    answer:
      "No. It listens through your Mac, so nobody sees an extra attendee. That also means telling people is up to you.",
  },
  {
    question: "Does Savvy have a hidden mode?",
    answer:
      "No. Savvy does not try to hide from screen sharing or from the people on the call. Tell them you are using it.",
  },
  {
    question: "Does it work with Zoom, Google Meet and Microsoft Teams?",
    answer:
      "Yes, and with any other call app on your Mac: Savvy hears system audio plus your microphone. In-person meetings work through the microphone.",
  },
  {
    question: "Is Savvy free?",
    answer:
      "Yes. The app is MIT-licensed. Use your own transcription and model accounts, or choose optional managed assistance. See pricing.",
  },
  {
    question: "Where does my data go?",
    answer:
      "Files, indexes, briefs and recordings stay on your Mac, and recordings are deleted after 30 days. Audio goes to your transcription provider and selected excerpts to your model provider, or through Savvy to Deepgram and Fireworks GLM-5.3 in managed mode.",
  },
  {
    question: "How is it different from Granola, Otter or Fireflies?",
    answer:
      "Those write up the call afterwards. Savvy helps during it: what to say, what to avoid, and which of your files says so.",
  },
  {
    question: "What do I need?",
    answer:
      "An Apple Silicon Mac on macOS 13 or newer, plus either a Savvy managed account or a Deepgram or AssemblyAI key with Claude Code or Codex CLI.",
  },
] as const;
