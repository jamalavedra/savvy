import { art as bestAiNoteTaker2026 } from "./best-ai-note-taker-2026";
import { art as bringYourOwnModelClaudeCodeCodex } from "./bring-your-own-model-claude-code-codex";
import { art as claudeCodeUseCasesBeyondCoding } from "./claude-code-use-cases-beyond-coding";
import { art as cluelyAlternatives } from "./cluely-alternatives";
import { art as deepgramVsAssemblyaiForMeetingTranscription } from "./deepgram-vs-assemblyai-for-meeting-transcription";
import { art as granolaAlternatives } from "./granola-alternatives";
import { art as localFirstMeetingAssistantVsMeetingBots } from "./local-first-meeting-assistant-vs-meeting-bots";
import { art as meetingPrep } from "./meeting-prep";
import { art as meetingRecordingConsentAndEtiquette } from "./meeting-recording-consent-and-etiquette";
import { art as otterAiAlternatives } from "./otter-ai-alternatives";
import type { PostArt } from "./types";
import { art as whatRealTimeMeetingAssistantMeans } from "./what-real-time-meeting-assistant-means";
import { art as whatToPrepareBeforeANegotiationCall } from "./what-to-prepare-before-a-negotiation-call";
import { art as whenSavvySpeaksUp } from "./when-savvy-speaks-up";

/** Every post has art; the build fails if a slug is missing (see getArt). */
const ART: Record<string, PostArt> = {
  "best-ai-note-taker-2026": bestAiNoteTaker2026,
  "bring-your-own-model-claude-code-codex": bringYourOwnModelClaudeCodeCodex,
  "claude-code-use-cases-beyond-coding": claudeCodeUseCasesBeyondCoding,
  "cluely-alternatives": cluelyAlternatives,
  "deepgram-vs-assemblyai-for-meeting-transcription": deepgramVsAssemblyaiForMeetingTranscription,
  "granola-alternatives": granolaAlternatives,
  "local-first-meeting-assistant-vs-meeting-bots": localFirstMeetingAssistantVsMeetingBots,
  "meeting-prep": meetingPrep,
  "meeting-recording-consent-and-etiquette": meetingRecordingConsentAndEtiquette,
  "otter-ai-alternatives": otterAiAlternatives,
  "what-real-time-meeting-assistant-means": whatRealTimeMeetingAssistantMeans,
  "what-to-prepare-before-a-negotiation-call": whatToPrepareBeforeANegotiationCall,
  "when-savvy-speaks-up": whenSavvySpeaksUp,
};

export function getArt(slug: string): PostArt {
  const art = ART[slug];
  if (!art) throw new Error(`blog art missing for "${slug}": add src/content/blog-art/${slug}.tsx`);
  return art;
}
