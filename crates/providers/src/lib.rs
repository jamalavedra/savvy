use savvy_domain::{
    EntityId, MeetingLedger, NegotiationBrief, SourceReference, TranscriptTurn, Trigger,
};

#[derive(Debug, Clone)]
pub struct RecommendationRequest {
    pub session_id: EntityId,
    pub generation_id: u64,
    pub transcript_revision: u64,
    pub context_pack_hash: String,
    pub trigger: Trigger,
    pub language: String,
    pub active_section_id: Option<EntityId>,
    pub brief: NegotiationBrief,
    pub recent_turns: Vec<TranscriptTurn>,
    pub evidence: Vec<SourceReference>,
    pub hard_constraints: Vec<String>,
    pub meeting_ledger: MeetingLedger,
    pub focal_turn_ids: Vec<EntityId>,
    pub deterministic_avoid: Option<String>,
}

pub fn recommendation_action_rule(trigger: Trigger) -> &'static str {
    match trigger {
        Trigger::Manual => "The user explicitly requested advice, so set action to show.",
        Trigger::Opportunity => "This is a silent opportunity scan. Set action to show only if the advice is concrete, immediately useful, specific to the supplied context, supported by the supplied transcript, brief, or evidence, and materially better than generic coaching. Set action to skip for generic reminders, restatements, untimely advice, unsupported claims, advice already obvious from the latest turns, or output without a concrete next utterance.",
        _ => "If advice would not be timely and useful, set action to skip.",
    }
}

pub fn cites_opportunity_focal_turn(
    trigger: Trigger,
    focal_turn_ids: &[EntityId],
    turn_ids: &[EntityId],
) -> bool {
    trigger != Trigger::Opportunity
        || turn_ids
            .iter()
            .any(|turn_id| focal_turn_ids.contains(turn_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opportunity_rule_is_strict_and_requires_a_focal_citation() {
        assert!(recommendation_action_rule(Trigger::Opportunity).contains("materially better"));
        let focal_id = "00000000-0000-0000-0000-000000000001"
            .parse::<EntityId>()
            .unwrap();
        let other_id = "00000000-0000-0000-0000-000000000002"
            .parse::<EntityId>()
            .unwrap();
        assert!(cites_opportunity_focal_turn(
            Trigger::Opportunity,
            &[focal_id],
            &[focal_id]
        ));
        assert!(!cites_opportunity_focal_turn(
            Trigger::Opportunity,
            &[focal_id],
            &[other_id]
        ));
        assert!(cites_opportunity_focal_turn(
            Trigger::Question,
            &[focal_id],
            &[other_id]
        ));
    }
}
