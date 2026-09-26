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

// Reasoning uses recent context; durable transcript storage retains every turn.
const MAX_CONTEXT_TURNS: usize = 256;
const MAX_CONTEXT_TEXT_BYTES: usize = 262_144;

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
        // Keep whole turns and chronological order, even with repeated or delayed timestamps.
        let mut bytes = 0;
        let mut keep_from = self.turns.len();
        for turn in self.turns.iter().rev().take(MAX_CONTEXT_TURNS) {
            let turn_bytes = turn.text.len().saturating_add(turn.language.len());
            if turn_bytes > MAX_CONTEXT_TEXT_BYTES - bytes {
                break;
            }
            bytes += turn_bytes;
            keep_from -= 1;
        }
        self.turns.drain(..keep_from);
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
    for update in updates.into_iter().take(8) {
        if !update.is_bounded()
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
        while ledger
            .items
            .iter()
            .map(LedgerItem::json_size_bound)
            .sum::<usize>()
            > 65534
        {
            ledger.items.remove(0);
        }
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
    fn rolling_context_bounds_bursts_without_changing_source_turns() {
        let source = TranscriptTurn {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            channel: SpeakerChannel::Other,
            text: "é".repeat(4096),
            language: "en".into(),
            start_ms: 1_000,
            end_ms: 2_000,
            is_final: true,
            confidence: 1.0,
        };
        for text in [String::from("x"), source.text.clone()] {
            let mut context = RollingContext::new(90_000);
            for _ in 0..10_000 {
                let mut turn = source.clone();
                turn.id = Uuid::new_v4();
                turn.text = text.clone();
                let latest_id = turn.id;
                context.push(turn);
                assert!(context.turns().len() <= MAX_CONTEXT_TURNS);
                assert!(
                    context
                        .turns()
                        .iter()
                        .map(|t| t.text.len() + t.language.len())
                        .sum::<usize>()
                        <= MAX_CONTEXT_TEXT_BYTES
                );
                assert_eq!(context.turns().last().unwrap().id, latest_id);
            }
            let retained = context.turns().to_vec();
            let mut delayed = source.clone();
            delayed.start_ms = 0;
            delayed.end_ms = 500;
            context.push(delayed);
            assert_eq!(context.turns().len(), retained.len());
            assert_eq!(
                context.turns().last().unwrap().id,
                retained.last().unwrap().id
            );
        }
        assert_eq!(source.text.len(), 8192);
        let mut context = RollingContext::new(90_000);
        let mut oversized = source.clone();
        oversized.text = "x".repeat(MAX_CONTEXT_TEXT_BYTES + 1);
        context.push(oversized);
        assert!(context.turns().is_empty());
        context.push(source);
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
    #[test]
    fn repeated_ledger_updates_keep_a_bounded_recent_history() {
        let turn = Uuid::new_v4();
        let allowed = HashSet::from([turn]);
        let mut ledger = MeetingLedger::default();
        for index in 0..1000 {
            apply_ledger_updates(
                &mut ledger,
                [LedgerItem {
                    kind: savvy_domain::LedgerKind::Decision,
                    text: format!("{index}:{}", "😀".repeat(500)),
                    source_turn_ids: vec![turn],
                }],
                &allowed,
            );
            assert!(
                ledger
                    .items
                    .iter()
                    .map(LedgerItem::json_size_bound)
                    .sum::<usize>()
                    <= 65534
            );
            assert!(ledger.items.len() <= 12);
        }
        assert!(ledger.items.last().unwrap().text.starts_with("999:"));
        let before = ledger.clone();
        for item in [
            LedgerItem {
                kind: savvy_domain::LedgerKind::Decision,
                text: "x".repeat(2049),
                source_turn_ids: vec![turn],
            },
            LedgerItem {
                kind: savvy_domain::LedgerKind::Decision,
                text: "duplicate".into(),
                source_turn_ids: vec![turn, turn],
            },
        ] {
            apply_ledger_updates(&mut ledger, [item], &allowed);
        }
        assert_eq!(ledger, before);
    }
}
