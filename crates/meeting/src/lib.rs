use savvy_domain::{EntityId, LedgerItem, MeetingLedger, OutlineSection, TranscriptTurn, Trigger};
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct OutlineTracker {
    sections: Vec<OutlineSection>,
    active: Option<EntityId>,
    pinned: Option<EntityId>,
    minimum_score: f32,
}

impl OutlineTracker {
    pub fn new(sections: Vec<OutlineSection>, minimum_score: f32) -> Self {
        Self {
            sections,
            active: None,
            pinned: None,
            minimum_score,
        }
    }

    pub fn active(&self) -> Option<EntityId> {
        self.pinned.or(self.active)
    }

    pub fn pin(&mut self, section: Option<EntityId>) {
        self.pinned = section.filter(|id| self.sections.iter().any(|item| item.id == *id));
    }

    pub fn observe(&mut self, text: &str) -> Option<EntityId> {
        if self.pinned.is_some() {
            return self.pinned;
        }
        let words = tokenize(text);
        let best = self
            .sections
            .iter()
            .map(|section| {
                let mut terms = tokenize(&section.title);
                terms.extend(tokenize(&section.objective));
                terms.extend(section.keywords.iter().flat_map(|item| tokenize(item)));
                let matches = words.intersection(&terms).count();
                let score = matches as f32 / terms.len().max(1) as f32;
                (section.id, score)
            })
            .max_by(|left, right| left.1.total_cmp(&right.1));

        if let Some((section_id, _)) = best.filter(|(_, score)| *score >= self.minimum_score) {
            self.active = Some(section_id);
        }
        self.active
    }
}

fn tokenize(text: &str) -> HashSet<String> {
    text.split(|character: char| !character.is_alphanumeric())
        .filter(|word| word.len() > 2)
        .map(str::to_lowercase)
        .collect()
}

#[derive(Debug, Clone)]
pub struct RollingContext {
    window_ms: u64,
    turns: Vec<TranscriptTurn>,
}

impl RollingContext {
    pub fn new(window_ms: u64) -> Self {
        Self {
            window_ms,
            turns: Vec::new(),
        }
    }

    pub fn push(&mut self, turn: TranscriptTurn) {
        self.turns.push(turn);
        self.turns.sort_by_key(|item| (item.start_ms, item.end_ms));
        let cutoff = self
            .turns
            .iter()
            .map(|item| item.end_ms)
            .max()
            .unwrap_or_default()
            .saturating_sub(self.window_ms);
        self.turns.retain(|item| item.end_ms >= cutoff);
    }

    pub fn turns(&self) -> &[TranscriptTurn] {
        &self.turns
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GenerationToken {
    pub session_id: EntityId,
    pub generation_id: u64,
    pub transcript_revision: u64,
}

#[derive(Debug, Clone)]
pub struct RecommendationCoordinator {
    session_id: EntityId,
    generation_id: u64,
    transcript_revision: u64,
    event_sequence: u64,
    active_generation: Option<(GenerationToken, Trigger)>,
    stopped: bool,
}

impl RecommendationCoordinator {
    pub fn new(session_id: EntityId) -> Self {
        Self {
            session_id,
            generation_id: 0,
            transcript_revision: 0,
            event_sequence: 0,
            active_generation: None,
            stopped: false,
        }
    }

    pub fn observe_turn(&mut self) -> u64 {
        self.transcript_revision += 1;
        self.transcript_revision
    }

    pub fn start_generation(&mut self, trigger: Trigger) -> GenerationToken {
        self.generation_id += 1;
        let token = GenerationToken {
            session_id: self.session_id,
            generation_id: self.generation_id,
            transcript_revision: self.transcript_revision,
        };
        self.active_generation = Some((token, trigger));
        token
    }

    pub fn accepts(&self, token: GenerationToken) -> bool {
        !self.stopped
            && self
                .active_generation
                .is_some_and(|active| active.0 == token)
    }

    pub fn active_generation(&self) -> Option<GenerationToken> {
        (!self.stopped)
            .then(|| self.active_generation.map(|active| active.0))
            .flatten()
    }

    pub fn active_trigger(&self) -> Option<Trigger> {
        (!self.stopped)
            .then(|| self.active_generation.map(|active| active.1))
            .flatten()
    }

    pub fn is_idle(&self) -> bool {
        !self.stopped && self.active_generation.is_none()
    }

    pub fn finish_generation(&mut self, token: GenerationToken) -> bool {
        if !self.accepts(token) {
            return false;
        }
        self.active_generation = None;
        true
    }

    pub fn next_sequence(&mut self) -> u64 {
        self.event_sequence += 1;
        self.event_sequence
    }

    pub fn stop(&mut self) {
        self.stopped = true;
        self.active_generation = None;
    }
}

pub fn apply_ledger_updates(
    ledger: &mut MeetingLedger,
    updates: impl IntoIterator<Item = LedgerItem>,
    allowed_turns: &HashSet<EntityId>,
) {
    for update in updates {
        if update.source_turn_ids.is_empty()
            || update
                .source_turn_ids
                .iter()
                .any(|turn_id| !allowed_turns.contains(turn_id))
        {
            continue;
        }
        ledger
            .items
            .retain(|item| item.kind != update.kind || item.text != update.text);
        while ledger
            .items
            .iter()
            .filter(|item| item.kind == update.kind)
            .count()
            >= 12
        {
            if let Some(index) = ledger
                .items
                .iter()
                .position(|item| item.kind == update.kind)
            {
                ledger.items.remove(index);
            }
        }
        ledger.items.push(update);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use savvy_domain::SpeakerChannel;
    use uuid::Uuid;

    fn section(title: &str, keywords: &[&str]) -> OutlineSection {
        OutlineSection {
            id: Uuid::new_v4(),
            title: title.into(),
            objective: String::new(),
            talking_points: vec![],
            keywords: keywords.iter().map(|value| (*value).into()).collect(),
            order: 0,
        }
    }

    #[test]
    fn pinned_section_cannot_be_overridden() {
        let pricing = section("Pricing", &["discount", "price"]);
        let timeline = section("Timeline", &["deadline", "launch"]);
        let mut tracker = OutlineTracker::new(vec![pricing.clone(), timeline], 0.2);
        tracker.pin(Some(pricing.id));
        assert_eq!(
            tracker.observe("The launch deadline is Friday"),
            Some(pricing.id)
        );
    }

    #[test]
    fn rolling_context_discards_old_turns() {
        let mut context = RollingContext::new(90_000);
        for end_ms in [10_000, 120_000] {
            context.push(TranscriptTurn {
                id: Uuid::new_v4(),
                session_id: Uuid::new_v4(),
                channel: SpeakerChannel::Other,
                text: "text".into(),
                language: "en".into(),
                start_ms: end_ms - 1_000,
                end_ms,
                is_final: true,
                confidence: 1.0,
            });
        }
        assert_eq!(context.turns().len(), 1);
    }

    #[test]
    fn rolling_context_orders_delayed_turns_chronologically() {
        let mut context = RollingContext::new(90_000);
        for start_ms in [5_000, 1_000] {
            context.push(TranscriptTurn {
                id: Uuid::new_v4(),
                session_id: Uuid::new_v4(),
                channel: SpeakerChannel::Other,
                text: start_ms.to_string(),
                language: "en".into(),
                start_ms,
                end_ms: start_ms + 500,
                is_final: true,
                confidence: 1.0,
            });
        }
        assert_eq!(
            context
                .turns()
                .iter()
                .map(|turn| turn.start_ms)
                .collect::<Vec<_>>(),
            vec![1_000, 5_000]
        );
    }

    #[test]
    fn only_latest_generation_is_accepted() {
        let session_id = Uuid::new_v4();
        let mut coordinator = RecommendationCoordinator::new(session_id);
        coordinator.observe_turn();
        let old = coordinator.start_generation(Trigger::Question);
        coordinator.observe_turn();
        assert!(coordinator.accepts(old));
        let latest = coordinator.start_generation(Trigger::Manual);
        assert!(!coordinator.accepts(old));
        assert!(coordinator.accepts(latest));
        assert_eq!(coordinator.active_trigger(), Some(Trigger::Manual));
        assert!(!coordinator.is_idle());
        assert_eq!(coordinator.active_generation(), Some(latest));
        assert!(coordinator.finish_generation(latest));
        assert!(coordinator.is_idle());
        assert_eq!(coordinator.active_generation(), None);
        assert!(!coordinator.finish_generation(latest));
        let stopped = coordinator.start_generation(Trigger::Risk);
        coordinator.stop();
        assert!(!coordinator.accepts(stopped));
        assert_eq!(coordinator.active_generation(), None);
    }

    #[test]
    fn scan_is_single_flight_and_survives_new_turns() {
        let mut coordinator = RecommendationCoordinator::new(Uuid::new_v4());
        let token = coordinator.start_generation(Trigger::Opportunity);
        coordinator.observe_turn();
        assert!(coordinator.accepts(token));
        assert!(!coordinator.is_idle());
        assert!(coordinator.finish_generation(token));
        assert!(coordinator.is_idle());
    }

    #[test]
    fn superseded_generation_is_finished_once_and_never_accepted_again() {
        let mut coordinator = RecommendationCoordinator::new(Uuid::new_v4());
        let scan = coordinator.start_generation(Trigger::Opportunity);
        assert!(coordinator.finish_generation(scan));
        let question = coordinator.start_generation(Trigger::Question);
        assert!(!coordinator.accepts(scan));
        assert!(!coordinator.finish_generation(scan));
        assert!(coordinator.accepts(question));
        assert_eq!(coordinator.active_trigger(), Some(Trigger::Question));
    }
}
