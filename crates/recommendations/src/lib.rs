use chrono::{Duration, Utc};
use savvy_domain::{
    EntityId, Grounding, NegotiationBrief, Recommendation, RecommendationLifecycle, SpeakerChannel,
    TranscriptTurn, Trigger,
};
use std::collections::HashSet;
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct TriggerDetector {
    risk_terms: Vec<String>,
    last_digest: Option<(String, u64)>,
}

impl TriggerDetector {
    pub fn new(risk_terms: impl IntoIterator<Item = String>) -> Self {
        Self {
            risk_terms: risk_terms
                .into_iter()
                .map(|term| term.to_lowercase())
                .collect(),
            last_digest: None,
        }
    }

    pub fn detect(&mut self, turn: &TranscriptTurn) -> Option<Trigger> {
        if !turn.is_final || turn.text.trim().is_empty() {
            return None;
        }
        let text = turn.text.to_lowercase();
        if self.risk_terms.iter().any(|term| text.contains(term)) {
            return Some(Trigger::Risk);
        }
        if !is_meaningful_remote_turn(turn) {
            return None;
        }
        let trigger = if contains_any(&text, COMMITMENT_TERMS) {
            Some(Trigger::Commitment)
        } else if contains_any(&text, OBJECTION_TERMS) {
            Some(Trigger::Objection)
        } else if text.ends_with('?') || starts_with_any(&text, QUESTION_PREFIXES) {
            Some(Trigger::Question)
        } else if contains_any(&text, DECISION_TERMS) {
            Some(Trigger::Decision)
        } else {
            None
        }?;
        let digest = text
            .split_whitespace()
            .take(16)
            .collect::<Vec<_>>()
            .join(" ");
        if self
            .last_digest
            .as_ref()
            .is_some_and(|(last, at)| last == &digest && turn.end_ms.saturating_sub(*at) < 10_000)
        {
            return None;
        }
        self.last_digest = Some((digest, turn.end_ms));
        Some(trigger)
    }
}

const QUESTION_PREFIXES: &[&str] = &[
    "what ",
    "why ",
    "how ",
    "when ",
    "who ",
    "can you ",
    "què ",
    "que ",
    "per què ",
    "com ",
    "quan ",
    "qui ",
    "quin ",
    "quina ",
    "pots ",
    "podríeu ",
    "por qué ",
    "cómo ",
    "cuándo ",
    "quién ",
    "puedes ",
];
const OBJECTION_TERMS: &[&str] = &[
    "disagree",
    "too expensive",
    "however",
    "massa car",
    "massa cara",
    "no estem d'acord",
    "però",
    "preocupa",
    "problema",
    "demasiado caro",
    "demasiado cara",
    "no estamos de acuerdo",
    "pero",
    "preocupa",
];
const COMMITMENT_TERMS: &[&str] = &[
    "commit",
    "guarantee",
    "sign today",
    "comprom",
    "garant",
    "signar avui",
    "compromiso",
    "garant",
    "firmar hoy",
];
const DECISION_TERMS: &[&str] = &[
    "we have decided",
    "next step",
    "hem decidit",
    "següent pas",
    "tirar endavant",
    "hemos decidido",
    "siguiente paso",
    "seguir adelante",
];
const BACKCHANNELS: &[&str] = &[
    "yes", "yeah", "right", "okay", "ok", "uh-huh", "sí", "si", "vale", "d'acord", "mhm",
];

fn contains_any(text: &str, terms: &[&str]) -> bool {
    terms.iter().any(|term| text.contains(term))
}

fn starts_with_any(text: &str, terms: &[&str]) -> bool {
    terms.iter().any(|term| text.starts_with(term))
}

fn is_backchannel(text: &str) -> bool {
    let normalized = text.trim_matches(|character: char| !character.is_alphanumeric());
    normalized.is_empty() || BACKCHANNELS.contains(&normalized)
}

pub fn is_meaningful_remote_turn(turn: &TranscriptTurn) -> bool {
    turn.is_final
        && turn.channel == SpeakerChannel::Other
        && !turn.text.trim().is_empty()
        && !is_backchannel(&turn.text.to_lowercase())
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RecommendationError {
    #[error("automatic recommendation confidence is below the display threshold")]
    LowConfidence,
    #[error("recommendation contains a source that was not provided to the model")]
    UnknownSource,
    #[error("dossier-grounded recommendation has no sources")]
    MissingSource,
    #[error("recommendation is not concise enough for live use")]
    TooLong,
}

pub fn validate_recommendation(
    recommendation: &Recommendation,
    allowed_chunk_ids: &HashSet<EntityId>,
) -> Result<(), RecommendationError> {
    if recommendation.trigger != Trigger::Manual && recommendation.grounding_score < 0.55 {
        return Err(RecommendationError::LowConfidence);
    }
    if matches!(
        recommendation.grounding,
        Grounding::Dossier | Grounding::Mixed
    ) && recommendation.sources.is_empty()
    {
        return Err(RecommendationError::MissingSource);
    }
    if recommendation
        .sources
        .iter()
        .any(|source| !allowed_chunk_ids.contains(&source.chunk_id))
    {
        return Err(RecommendationError::UnknownSource);
    }
    if recommendation.say.split_whitespace().count() > 90 {
        return Err(RecommendationError::TooLong);
    }
    Ok(())
}

pub fn recommend_from_hard_constraint(
    brief: &NegotiationBrief,
    turn: &TranscriptTurn,
    trigger: Trigger,
    outline_section_id: Option<EntityId>,
) -> Option<Recommendation> {
    let constraints = brief
        .red_lines
        .iter()
        .chain(&brief.prohibited_claims)
        .chain(&brief.unauthorized_commitments);
    let red_line = constraints
        .clone()
        .find(|rule| {
            let rule = rule.to_lowercase();
            rule.split_whitespace()
                .filter(|word| word.len() > 4)
                .any(|word| turn.text.to_lowercase().contains(word))
        })
        .or_else(|| {
            (trigger == Trigger::Risk)
                .then(|| constraints.into_iter().next())
                .flatten()
        })?
        .clone();
    let now = Utc::now();
    Some(Recommendation {
        id: uuid::Uuid::new_v4(),
        session_id: turn.session_id,
        outline_section_id,
        trigger,
        say: "Pause and clarify the exact scope and authority before agreeing.".into(),
        avoid: Some(red_line),
        rationale: "This turn matches a hard constraint in the selected meeting material.".into(),
        grounding: Grounding::Brief,
        grounding_score: 0.95,
        language: brief.response_language.clone(),
        sources: vec![],
        source_turn_ids: vec![turn.id],
        created_at: now,
        expires_at: now + Duration::seconds(45),
        generation_id: 0,
        transcript_revision: 0,
        context_pack_hash: String::new(),
        provider: None,
        model: None,
        lifecycle: RecommendationLifecycle::Local,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use savvy_domain::{ContextSourceKind, SourceLocator, SourceReference};
    use std::path::PathBuf;
    use uuid::Uuid;

    fn recommendation(chunk_id: EntityId) -> Recommendation {
        let now = Utc::now();
        Recommendation {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            outline_section_id: None,
            trigger: Trigger::Question,
            say: "We can hold the timeline if scope remains unchanged.".into(),
            avoid: None,
            rationale: "The implementation plan fixes scope before timeline.".into(),
            grounding: Grounding::Dossier,
            grounding_score: 0.9,
            language: "en".into(),
            sources: vec![SourceReference {
                kind: ContextSourceKind::Client,
                document_id: Uuid::new_v4(),
                chunk_id,
                relative_path: PathBuf::from("proposal.md"),
                locator: SourceLocator::document("Scope"),
                excerpt: "Timeline assumes unchanged scope".into(),
            }],
            source_turn_ids: vec![],
            created_at: now,
            expires_at: now + Duration::seconds(30),
            generation_id: 1,
            transcript_revision: 1,
            context_pack_hash: "context".into(),
            provider: Some("fixture".into()),
            model: None,
            lifecycle: RecommendationLifecycle::Completed,
        }
    }

    #[test]
    fn rejects_fabricated_source_identifiers() {
        let recommendation = recommendation(Uuid::new_v4());
        let allowed = HashSet::new();
        assert_eq!(
            validate_recommendation(&recommendation, &allowed),
            Err(RecommendationError::UnknownSource)
        );
    }

    #[test]
    fn risk_recommendation_carries_the_approved_red_line() {
        let mut brief = test_brief();
        brief.red_lines = vec!["Do not commit to an unapproved date".into()];
        let turn = transcript("Can you guarantee delivery next Friday?");
        let recommendation = recommend_from_hard_constraint(&brief, &turn, Trigger::Risk, None)
            .expect("matched hard constraint");
        assert_eq!(
            recommendation.avoid.as_deref(),
            Some("Do not commit to an unapproved date")
        );
        assert_eq!(recommendation.source_turn_ids, vec![turn.id]);
    }

    #[test]
    fn catalan_remote_question_triggers_but_self_question_does_not() {
        let mut detector = TriggerDetector::new(Vec::new());
        let mut turn = transcript("Què necessiteu per tirar endavant?");
        turn.language = "ca".into();
        assert_eq!(detector.detect(&turn), Some(Trigger::Question));
        turn.channel = SpeakerChannel::SelfSpeaker;
        turn.end_ms += 11_000;
        assert_eq!(detector.detect(&turn), None);
    }

    #[test]
    fn meaningful_remote_turns_include_one_word_questions_not_backchannels() {
        let mut turn = transcript("Why?");
        assert!(is_meaningful_remote_turn(&turn));
        turn.text = "Què?".into();
        assert!(is_meaningful_remote_turn(&turn));
        for backchannel in ["Okay.", "sí", "d'acord!"] {
            turn.text = backchannel.into();
            assert!(!is_meaningful_remote_turn(&turn), "{backchannel}");
        }
        turn.text.clear();
        assert!(!is_meaningful_remote_turn(&turn));
        turn.text = "A useful point".into();
        turn.channel = SpeakerChannel::SelfSpeaker;
        assert!(!is_meaningful_remote_turn(&turn));
        turn.channel = SpeakerChannel::Unknown;
        assert!(!is_meaningful_remote_turn(&turn));
        turn.channel = SpeakerChannel::Other;
        turn.is_final = false;
        assert!(!is_meaningful_remote_turn(&turn));
    }

    #[test]
    fn one_word_remote_questions_trigger() {
        let mut detector = TriggerDetector::new(Vec::new());
        assert_eq!(
            detector.detect(&transcript("Why?")),
            Some(Trigger::Question)
        );
    }

    #[test]
    fn first_person_plural_statements_are_not_questions() {
        let mut detector = TriggerDetector::new(Vec::new());
        assert_eq!(
            detector.detect(&transcript("Podem revisar l'esborrany.")),
            None
        );
        assert_eq!(
            detector.detect(&transcript("Podemos revisar el borrador.")),
            None
        );
        assert_eq!(
            detector.detect(&transcript("Podemos revisar el borrador?")),
            Some(Trigger::Question)
        );
    }

    #[test]
    fn self_speech_only_triggers_on_an_exact_hard_constraint() {
        let mut detector = TriggerDetector::new(vec!["no prometre una data de lliurament".into()]);
        let mut turn = transcript("Podem parlar de la data de lliurament");
        turn.channel = SpeakerChannel::SelfSpeaker;
        turn.language = "ca".into();
        assert_eq!(detector.detect(&turn), None);
        turn.text = "No prometre una data de lliurament".into();
        assert_eq!(detector.detect(&turn), Some(Trigger::Risk));
    }

    fn transcript(text: &str) -> TranscriptTurn {
        TranscriptTurn {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            channel: savvy_domain::SpeakerChannel::Other,
            text: text.into(),
            language: "en".into(),
            start_ms: 0,
            end_ms: 1_000,
            is_final: true,
            confidence: 0.95,
        }
    }

    fn test_brief() -> NegotiationBrief {
        NegotiationBrief {
            id: Uuid::new_v4(),
            client_id: Some(Uuid::new_v4()),
            version: 1,
            status: savvy_domain::BriefStatus::Approved,
            title: "Brief".into(),
            objective: "Reach agreement".into(),
            response_language: "English".into(),
            our_position: String::new(),
            client_position: String::new(),
            priorities: vec!["protect the implementation plan".into()],
            agenda: vec![],
            desired_outcomes: vec![],
            questions_to_ask: vec!["What is driving the date?".into()],
            facts_to_use: vec![],
            concessions: vec![],
            red_lines: vec![],
            prohibited_claims: vec![],
            unauthorized_commitments: vec![],
            risks: vec![],
            custom_instructions: String::new(),
            document_path: None,
            document_content: String::new(),
            created_at: Utc::now(),
        }
    }
}
