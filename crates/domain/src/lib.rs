use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

pub type EntityId = Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientWorkspace {
    pub id: EntityId,
    pub name: String,
    pub folder_path: PathBuf,
    pub index_status: IndexStatus,
    pub document_count: usize,
    pub last_indexed_at: Option<DateTime<Utc>>,
    pub active_brief_id: Option<EntityId>,
}

impl ClientWorkspace {
    pub fn new(name: impl Into<String>, folder_path: PathBuf) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            folder_path,
            index_status: IndexStatus::Pending,
            document_count: 0,
            last_indexed_at: None,
            active_brief_id: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IndexStatus {
    Pending,
    Indexing,
    Ready,
    Stale,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceDocument {
    pub id: EntityId,
    pub client_id: EntityId,
    pub relative_path: PathBuf,
    pub kind: DocumentKind,
    pub content_hash: String,
    pub byte_size: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DocumentKind {
    Pdf,
    Docx,
    Pptx,
    Xlsx,
    Csv,
    Markdown,
    Text,
    Epub,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceLocator {
    pub label: String,
    pub page: Option<u32>,
    pub slide: Option<u32>,
    pub sheet: Option<String>,
    pub row_start: Option<u32>,
    pub row_end: Option<u32>,
    pub chapter: Option<String>,
    pub heading: Option<String>,
    pub line_start: Option<u32>,
    pub line_end: Option<u32>,
}

impl SourceLocator {
    pub fn document(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            page: None,
            slide: None,
            sheet: None,
            row_start: None,
            row_end: None,
            chapter: None,
            heading: None,
            line_start: None,
            line_end: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceReference {
    pub kind: ContextSourceKind,
    pub document_id: EntityId,
    pub chunk_id: EntityId,
    pub relative_path: PathBuf,
    pub locator: SourceLocator,
    pub excerpt: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ContextSourceKind {
    Guideline,
    Client,
    Brief,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexedSourceChunk {
    pub scope_id: EntityId,
    pub source: SourceReference,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutlineSection {
    pub id: EntityId,
    pub title: String,
    pub objective: String,
    pub talking_points: Vec<String>,
    pub keywords: Vec<String>,
    pub order: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroundedFact {
    pub statement: String,
    pub sources: Vec<SourceReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Concession {
    pub item: String,
    pub condition: String,
    pub requires_approval: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BriefStatus {
    Draft,
    Approved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NegotiationBrief {
    pub id: EntityId,
    #[serde(default)]
    pub client_id: Option<EntityId>,
    pub version: u32,
    pub status: BriefStatus,
    pub title: String,
    pub objective: String,
    pub response_language: String,
    pub our_position: String,
    pub client_position: String,
    pub priorities: Vec<String>,
    pub agenda: Vec<OutlineSection>,
    pub desired_outcomes: Vec<String>,
    pub questions_to_ask: Vec<String>,
    pub facts_to_use: Vec<GroundedFact>,
    pub concessions: Vec<Concession>,
    pub red_lines: Vec<String>,
    pub prohibited_claims: Vec<String>,
    pub unauthorized_commitments: Vec<String>,
    pub risks: Vec<String>,
    pub custom_instructions: String,
    #[serde(default)]
    pub document_path: Option<PathBuf>,
    #[serde(default)]
    pub document_content: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceReadiness {
    pub index_status: IndexStatus,
    pub document_count: usize,
    pub checked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreparationSnapshot {
    pub guidelines: SourceReadiness,
    pub client: Option<ClientWorkspace>,
    pub brief: Option<NegotiationBrief>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SpeakerChannel {
    SelfSpeaker,
    Other,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptTurn {
    pub id: EntityId,
    pub session_id: EntityId,
    pub channel: SpeakerChannel,
    pub text: String,
    pub language: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub is_final: bool,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum LanguagePolicy {
    Fixed { language: String },
    Auto { preferred: String },
}

impl LanguagePolicy {
    pub fn response_language(&self) -> &str {
        match self {
            Self::Fixed { language } => language,
            Self::Auto { preferred } => preferred,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BriefSnapshot {
    pub brief_id: EntityId,
    pub version: u32,
    pub content_hash: String,
    pub markdown: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextPack {
    pub hash: String,
    pub language_policy: LanguagePolicy,
    pub hard_constraints: Vec<String>,
    pub guideline_sources: Vec<SourceReference>,
    pub client_sources: Vec<SourceReference>,
    pub brief: Option<BriefSnapshot>,
    pub client_id: Option<EntityId>,
    pub source_revision: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LedgerKind {
    Decision,
    Objection,
    Question,
    Commitment,
    Constraint,
    Concession,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerItem {
    pub kind: LedgerKind,
    pub text: String,
    pub source_turn_ids: Vec<EntityId>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MeetingLedger {
    pub items: Vec<LedgerItem>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Trigger {
    Question,
    Objection,
    Commitment,
    Decision,
    Risk,
    Opportunity,
    Pause,
    Manual,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Grounding {
    Dossier,
    Brief,
    Mixed,
    Inference,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecommendationLifecycle {
    Local,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub id: EntityId,
    pub session_id: EntityId,
    pub outline_section_id: Option<EntityId>,
    pub trigger: Trigger,
    pub say: String,
    pub avoid: Option<String>,
    pub rationale: String,
    pub grounding: Grounding,
    pub grounding_score: f32,
    pub language: String,
    pub sources: Vec<SourceReference>,
    pub source_turn_ids: Vec<EntityId>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub generation_id: u64,
    pub transcript_revision: u64,
    pub context_pack_hash: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub lifecycle: RecommendationLifecycle,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MeetingState {
    Preparing,
    Recording,
    Paused,
    Completed,
    Interrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSession {
    pub id: EntityId,
    #[serde(default)]
    pub client_id: Option<EntityId>,
    #[serde(default)]
    pub brief_id: Option<EntityId>,
    pub state: MeetingState,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub audio_path: Option<PathBuf>,
    pub context_pack_hash: String,
    pub source_index_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHealth {
    pub provider: String,
    pub available: bool,
    pub credential_present: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub version: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSnapshot {
    pub clients: Vec<ClientWorkspace>,
    pub active_brief: Option<NegotiationBrief>,
    pub active_session: Option<MeetingSession>,
    pub latest_recommendation: Option<Recommendation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptUpdate {
    pub turn: TranscriptTurn,
    pub recommendation: Option<Recommendation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MeetingEvent {
    Transcript {
        session_id: EntityId,
        sequence: u64,
        turn: TranscriptTurn,
        interim: bool,
    },
    RecommendationStarted {
        session_id: EntityId,
        sequence: u64,
        generation_id: u64,
        transcript_revision: u64,
        trigger: Trigger,
        local: Option<Recommendation>,
    },
    RecommendationCompleted {
        session_id: EntityId,
        sequence: u64,
        generation_id: u64,
        transcript_revision: u64,
        recommendation: Recommendation,
    },
    RecommendationSkipped {
        session_id: EntityId,
        sequence: u64,
        generation_id: u64,
        transcript_revision: u64,
    },
    RecommendationFailed {
        session_id: EntityId,
        sequence: u64,
        generation_id: u64,
        transcript_revision: u64,
        message: String,
    },
    RecommendationCancelled {
        session_id: EntityId,
        sequence: u64,
        generation_id: u64,
        transcript_revision: u64,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opportunity_trigger_and_started_event_serialize() {
        let session_id = Uuid::new_v4();
        let event = MeetingEvent::RecommendationStarted {
            session_id,
            sequence: 3,
            generation_id: 2,
            transcript_revision: 7,
            trigger: Trigger::Opportunity,
            local: None,
        };
        let value = serde_json::to_value(&event).expect("serialize meeting event");
        assert_eq!(value["type"], "recommendationStarted");
        assert_eq!(value["trigger"], "opportunity");
        assert_eq!(
            serde_json::from_value::<MeetingEvent>(value).expect("deserialize meeting event"),
            event
        );
    }
}
