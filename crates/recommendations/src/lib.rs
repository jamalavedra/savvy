use chrono::{Duration, Utc};
use savvy_domain::{
    EntityId, Grounding, NegotiationBrief, Recommendation, RecommendationLifecycle, SpeakerChannel,
    TranscriptTurn, Trigger,
};
use std::collections::HashSet;
use thiserror::Error;

/// Detects the two turn-level triggers that make Savvy visibly think: a remote
/// question, or any speaker touching a hard constraint from the brief.
#[derive(Debug, Clone)]
pub struct TriggerDetector {
    hard_constraints: Vec<String>,
    last_digest: Option<(String, u64)>,
}

impl TriggerDetector {
    pub fn new(hard_constraints: impl IntoIterator<Item = String>) -> Self {
        Self {
            hard_constraints: hard_constraints.into_iter().collect(),
            last_digest: None,
        }
    }

    pub fn detect(&mut self, turn: &TranscriptTurn) -> Option<Trigger> {
        if !turn.is_final || turn.text.trim().is_empty() {
            return None;
        }
        let text = turn.text.to_lowercase();
        let trigger = if matching_constraint(&text, &self.hard_constraints).is_some() {
            Trigger::Risk
        } else if is_meaningful_remote_turn(turn) && is_question(&text) {
            Trigger::Question
        } else {
            return None;
        };
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

/// A remote turn that signals the conversation has moved — a commitment,
/// objection, or decision — and makes the silent scan worth running now.
pub fn accelerates_scan(turn: &TranscriptTurn) -> bool {
    if !is_meaningful_remote_turn(turn) {
        return false;
    }
    let words = tokenize(&turn.text);
    SCAN_ACCELERATOR_TERMS
        .iter()
        .any(|term| contains_phrase(&words, term))
}

fn is_question(text: &str) -> bool {
    let trimmed = text.trim_end_matches(|character: char| {
        character.is_whitespace() || "\"'”»)".contains(character)
    });
    trimmed.ends_with('?')
        || QUESTION_PREFIXES
            .iter()
            .any(|prefix| text.starts_with(prefix))
}

/// The hard constraint that best matches the turn, if at least half of its
/// distinctive words appear as whole words in the turn.
pub fn matching_constraint<'a>(text: &str, constraints: &'a [String]) -> Option<&'a String> {
    let words = tokenize(text);
    constraints
        .iter()
        .filter_map(|constraint| {
            let terms = tokenize(constraint);
            if terms.is_empty() {
                return None;
            }
            let matched = terms.iter().filter(|term| words.contains(*term)).count();
            let score = matched as f32 / terms.len() as f32;
            // ponytail: half-of-distinctive-words heuristic; swap for a phrase
            // matcher if briefs start carrying long, stopword-heavy constraints.
            (score >= 0.5).then_some((constraint, score))
        })
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .map(|(constraint, _)| constraint)
}

fn tokenize(text: &str) -> HashSet<String> {
    text.to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| word.len() >= 4)
        .map(str::to_owned)
        .collect()
}

fn contains_phrase(words: &HashSet<String>, phrase: &str) -> bool {
    phrase.split_whitespace().all(|word| words.contains(word))
}

const QUESTION_PREFIXES: &[&str] = &[
    "what ",
    "why ",
    "how ",
    "when ",
    "who ",
    "can you ",
    "could you ",
    "què ",
    "per què ",
    "pots ",
    "podríeu ",
    "qué ",
    "por qué ",
    "cómo ",
    "cuándo ",
    "quién ",
    "puedes ",
    "podrías ",
];
const SCAN_ACCELERATOR_TERMS: &[&str] = &[
    "commit",
    "guarantee",
    "sign today",
    "disagree",
    "expensive",
    "however",
    "decided",
    "next step",
    "comprometre",
    "garantir",
    "signar avui",
    "massa",
    "preocupa",
    "problema",
    "decidit",
    "següent",
    "compromiso",
    "garantizar",
    "firmar",
    "demasiado",
    "decidido",
    "siguiente paso",
];
const BACKCHANNELS: &[&str] = &[
    "yes", "yeah", "right", "okay", "ok", "uh-huh", "sí", "si", "vale", "d'acord", "mhm",
];

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
        .chain(&brief.unauthorized_commitments)
        .cloned()
        .collect::<Vec<_>>();
    let red_line = matching_constraint(&turn.text, &constraints)?.clone();
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
    fn validation_rejects_each_failure_mode_and_exempts_manual_confidence() {
        let chunk_id = Uuid::new_v4();
        let allowed = HashSet::from([chunk_id]);
        assert_eq!(
            validate_recommendation(&recommendation(chunk_id), &allowed),
            Ok(())
        );
        assert_eq!(
            validate_recommendation(&recommendation(Uuid::new_v4()), &allowed),
            Err(RecommendationError::UnknownSource)
        );
        let mut low = recommendation(chunk_id);
        low.grounding_score = 0.54;
        assert_eq!(
            validate_recommendation(&low, &allowed),
            Err(RecommendationError::LowConfidence)
        );
        low.trigger = Trigger::Manual;
        assert_eq!(validate_recommendation(&low, &allowed), Ok(()));
        let mut unsourced = recommendation(chunk_id);
        unsourced.sources.clear();
        assert_eq!(
            validate_recommendation(&unsourced, &allowed),
            Err(RecommendationError::MissingSource)
        );
        let mut long = recommendation(chunk_id);
        long.say = "word ".repeat(91);
        assert_eq!(
            validate_recommendation(&long, &allowed),
            Err(RecommendationError::TooLong)
        );
    }

    #[test]
    fn detector_table() {
        let constraints = vec![
            "Do not promise a delivery date before Q3".to_owned(),
            "Never discuss pricing without approval".to_owned(),
        ];
        let cases: &[(&str, SpeakerChannel, Option<Trigger>)] = &[
            (
                "Can you guarantee the delivery date?",
                SpeakerChannel::Other,
                Some(Trigger::Risk),
            ),
            (
                "We can promise the delivery date",
                SpeakerChannel::SelfSpeaker,
                Some(Trigger::Risk),
            ),
            (
                "The update is ready before lunch",
                SpeakerChannel::Other,
                None,
            ),
            ("Why?", SpeakerChannel::Other, Some(Trigger::Question)),
            (
                "So that is the plan? ",
                SpeakerChannel::Other,
                Some(Trigger::Question),
            ),
            (
                "How soon can you start",
                SpeakerChannel::Other,
                Some(Trigger::Question),
            ),
            (
                "Què necessiteu per tirar endavant",
                SpeakerChannel::Other,
                Some(Trigger::Question),
            ),
            ("Que sigui aviat", SpeakerChannel::Other, None),
            ("Com a resum, tot bé", SpeakerChannel::Other, None),
            ("Podemos revisar el borrador.", SpeakerChannel::Other, None),
            (
                "Podemos revisar el borrador?",
                SpeakerChannel::Other,
                Some(Trigger::Question),
            ),
            ("What is the timeline?", SpeakerChannel::SelfSpeaker, None),
            ("What is the timeline?", SpeakerChannel::Unknown, None),
            (
                "However, the timeline worries us",
                SpeakerChannel::Other,
                None,
            ),
            ("We have decided to move on", SpeakerChannel::Other, None),
            ("Okay.", SpeakerChannel::Other, None),
        ];
        for (text, channel, expected) in cases {
            let mut detector = TriggerDetector::new(constraints.clone());
            let mut turn = transcript(text);
            turn.channel = *channel;
            assert_eq!(detector.detect(&turn), *expected, "{text}");
        }
    }

    #[test]
    fn interim_turns_never_trigger() {
        let mut detector = TriggerDetector::new(Vec::new());
        let mut turn = transcript("Why?");
        turn.is_final = false;
        assert_eq!(detector.detect(&turn), None);
    }

    #[test]
    fn identical_turns_are_deduped_for_ten_seconds() {
        let mut detector = TriggerDetector::new(vec!["pricing approval".into()]);
        let mut question = transcript("Why is that?");
        assert_eq!(detector.detect(&question), Some(Trigger::Question));
        question.end_ms += 9_999;
        assert_eq!(detector.detect(&question), None);
        question.end_ms += 1;
        assert_eq!(detector.detect(&question), Some(Trigger::Question));

        let mut risk = transcript("We need pricing approval");
        risk.end_ms = question.end_ms + 1_000;
        assert_eq!(detector.detect(&risk), Some(Trigger::Risk));
        risk.end_ms += 1_000;
        assert_eq!(detector.detect(&risk), None);
    }

    #[test]
    fn accelerators_are_remote_whole_word_matches() {
        assert!(accelerates_scan(&transcript(
            "However, the timeline worries us"
        )));
        assert!(accelerates_scan(&transcript("Hemos decidido seguir")));
        assert!(!accelerates_scan(&transcript(
            "The committee meets on Friday"
        )));
        let mut own = transcript("However, we disagree");
        own.channel = SpeakerChannel::SelfSpeaker;
        assert!(!accelerates_scan(&own));
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
    fn hard_constraint_card_quotes_the_matching_constraint_only() {
        let mut brief = test_brief();
        brief.red_lines = vec![
            "Do not offer a standalone discount".into(),
            "Do not commit to an unapproved date".into(),
        ];
        let turn = transcript("Can you commit to a date this week?");
        let recommendation = recommend_from_hard_constraint(&brief, &turn, Trigger::Risk, None)
            .expect("matched hard constraint");
        assert_eq!(
            recommendation.avoid.as_deref(),
            Some("Do not commit to an unapproved date")
        );
        assert_eq!(recommendation.source_turn_ids, vec![turn.id]);
        assert!(recommend_from_hard_constraint(
            &brief,
            &transcript("What is the weather like?"),
            Trigger::Risk,
            None
        )
        .is_none());
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
