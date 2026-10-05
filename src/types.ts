export type IndexStatus = "pending" | "indexing" | "ready" | "stale" | "failed";

export type ClientWorkspace = {
  id: string;
  name: string;
  folderPath: string;
  indexStatus: IndexStatus;
  documentCount: number;
  lastIndexedAt: string | null;
  activeBriefId: string | null;
  excludedPaths: string[];
};

export type DocumentKind =
  "pdf" | "docx" | "pptx" | "xlsx" | "csv" | "markdown" | "text" | "epub";

export type ClientDocument = {
  relativePath: string;
  kind: DocumentKind | null;
  included: boolean;
};

export type OutlineSection = {
  id: string;
  title: string;
  objective: string;
  talkingPoints: string[];
  keywords: string[];
  order: number;
};

export type NegotiationBrief = {
  id: string;
  clientId: string | null;
  version: number;
  status: "draft" | "approved" | "superseded";
  title: string;
  objective: string;
  responseLanguage: string;
  ourPosition: string;
  clientPosition: string;
  priorities: string[];
  agenda: OutlineSection[];
  desiredOutcomes: string[];
  questionsToAsk: string[];
  redLines: string[];
  prohibitedClaims: string[];
  unauthorizedCommitments: string[];
  risks: string[];
  customInstructions: string;
  documentPath: string | null;
  documentContent: string;
  createdAt: string;
  approvedAt: string | null;
};

export type SourceReadiness = {
  indexStatus: IndexStatus;
  documentCount: number;
  checkedAt: string | null;
};

export type PreparationSnapshot = {
  guidelines: SourceReadiness;
  client: ClientWorkspace | null;
  brief: NegotiationBrief | null;
};

export type Recommendation = {
  id: string;
  sessionId: string;
  trigger: RecommendationTrigger;
  say: string;
  avoid: string | null;
  rationale: string;
  grounding: "dossier" | "brief" | "mixed" | "inference";
  groundingScore: number;
  language: string;
  sources: Array<{
    kind: "guideline" | "client" | "brief";
    documentId: string;
    chunkId: string;
    relativePath: string;
    locator: { label: string };
    excerpt: string;
  }>;
  sourceTurnIds: string[];
  createdAt: string;
  expiresAt: string;
  generationId: number;
  transcriptRevision: number;
  contextPackHash: string;
  provider: string | null;
  model: string | null;
  lifecycle: "local" | "completed" | "failed";
};

export type MeetingSession = {
  id: string;
  clientId: string | null;
  briefId: string | null;
  state: "preparing" | "recording" | "paused" | "completed" | "interrupted";
  startedAt: string;
  endedAt: string | null;
  audioPath: string | null;
  contextPackHash: string;
  sourceIndexRevision: string;
};

export type TranscriptTurn = {
  id: string;
  sessionId: string;
  channel: "selfSpeaker" | "other" | "unknown";
  text: string;
  language: string;
  startMs: number;
  endMs: number;
  isFinal: boolean;
  confidence: number;
};

export type TranscriptUpdate = {
  turn: TranscriptTurn;
  recommendation: Recommendation | null;
};

export type RecommendationTrigger =
  | "question"
  | "objection"
  | "commitment"
  | "decision"
  | "risk"
  | "opportunity"
  | "manual";

export type MeetingEvent =
  | {
      type: "transcript";
      sessionId: string;
      sequence: number;
      turn: TranscriptTurn;
      interim: boolean;
    }
  | {
      type: "recommendationStarted";
      sessionId: string;
      sequence: number;
      generationId: number;
      transcriptRevision: number;
      trigger: RecommendationTrigger;
      local: Recommendation | null;
    }
  | {
      type: "recommendationThinking";
      sessionId: string;
      sequence: number;
      generationId: number;
      transcriptRevision: number;
    }
  | {
      type: "recommendationCompleted";
      sessionId: string;
      sequence: number;
      generationId: number;
      transcriptRevision: number;
      recommendation: Recommendation;
    }
  | {
      type:
        | "recommendationSkipped"
        | "recommendationFailed"
        | "recommendationCancelled";
      sessionId: string;
      sequence: number;
      generationId: number;
      transcriptRevision: number;
      message?: string;
    };

export type MeetingHistoryItem = {
  session: MeetingSession;
  clientName: string;
  recommendations: Recommendation[];
};

export type DashboardSnapshot = {
  clients: ClientWorkspace[];
  activeBrief: NegotiationBrief | null;
  activeSession: MeetingSession | null;
  latestRecommendation: Recommendation | null;
};

export type AppStatus = {
  version: string;
  platform: string;
};

export type AppSettings = {
  serviceMode: "byok" | "managed";
  startListeningShortcut: string;
  selectedMicrophone: string | null;
  selectedChannel: number | null;
  microphoneOnly: boolean;
  audioFeedback: boolean;
  selectedOutputDevice: string | null;
  audioFeedbackVolume: number;
  recommendationProvider: "codex" | "claude";
  codexModel: "default" | "gpt-5.6-sol" | "gpt-5.6-terra";
  codexServiceTier: "default" | "priority";
  claudeModel: "claude-sonnet-5" | "claude-opus-5" | "claude-fable-5";
  claudeContextWindow: "200k" | "1m";
  guidanceFolder: string | null;
  briefGenerationPrompt: string;
  transcriptionProvider: "deepgram" | "assemblyAi";
  transcriptionModel: string;
  transcriptionLanguage: string;
  startHidden: boolean;
  launchOnStartup: boolean;
  showTrayIcon: boolean;
  overlayStyle: "minimal" | "live";
  overlayPosition: "bottom" | "top";
  showLiveTranscript: boolean;
  theme: "system" | "light" | "dark";
  onboardingCompleted: boolean;
};

export type TranscriptionKeyStatus = {
  deepgram: boolean;
  assemblyAi: boolean;
};

export type ProviderHealth = {
  provider: "codex" | "claude";
  available: boolean;
  credentialPresent: boolean;
  message: string;
};

export type AppPaths = {
  appDataDirectory: string;
  logDirectory: string;
};

export type AudioDevice = {
  name: string;
  isDefault: boolean;
  channels: number;
};

export type ManagedAccount = {
  identity?: {
    issuer: string;
    subject: string;
    name: string | null;
    email: string | null;
    emailVerified: boolean;
  };
  allowances?: Record<
    "monthly" | "pack",
    {
      meetingMsAvailable: number;
      meetingMsReserved: number;
      briefsAvailable: number;
    }
  >;
  latestConfirmedPurchase?: {
    product: string;
    attemptId: string;
    status: "complete" | "failed" | "expired";
  } | null;
  purchaseAvailability?: { monthly: boolean; pack: boolean };
  catalog?: typeof import("../config/managed-catalog.json") | null;
  pendingPurchases?: {
    product: "monthly" | "pack";
    attemptId: string;
    status: string;
  }[];
  paymentPending?: boolean;
  accountIdentity?: string;
  nowMs: number;
  meetingMsAvailable: number;
  meetingMsReserved: number;
  briefsAvailable: number;
  monthlyMsTotal: number;
  monthlyMsUsed: number;
  periodEndMs: number | null;
  subscription: {
    status: string;
    paidThroughMs: number | null;
    cancelAtPeriodEnd: boolean;
  } | null;
};

export type ManagedAuthorization = {
  flowId: string;
  authorizationUrl: string;
};
