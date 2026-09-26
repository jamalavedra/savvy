use savvy_domain::{NegotiationBrief, OutlineSection};
use std::collections::HashMap;
use uuid::Uuid;

// Match JavaScript's Markdown heading whitespace, including BOM but excluding NEL.
fn markdown_whitespace(character: char) -> bool {
    (character.is_whitespace() && character != '\u{85}') || character == '\u{feff}'
}

/// Keep metadata only while its canonical rendering still matches the document.
/// Edited/imported Markdown is the source of runtime policy, never old JSON fields.
// ponytail: supports H2 policy sections and H3 discussion outline only; use a
// CommonMark parser if rich-format policy becomes a supported input.
pub fn synchronize(brief: &mut NegotiationBrief) -> Result<(), String> {
    if brief.document_content.len() > super::MAX_BRIEF_DOCUMENT_BYTES as usize {
        return Err("brief document is too large".into());
    }
    if brief.document_content == super::render_brief_markdown(brief) {
        return Ok(());
    }
    let mut sections: HashMap<String, Vec<String>> = HashMap::new();
    let mut section = String::new();
    let mut fence: Option<(char, usize)> = None;
    let mut agenda: Vec<OutlineSection> = Vec::new();
    let mut policy_lines = 0;
    let mut paragraph_break = true;
    for raw in brief.document_content.lines() {
        let line = raw.trim_matches(markdown_whitespace);
        if let Some((character, length)) = fence {
            if line.chars().take_while(|c| *c == character).count() >= length
                && line
                    .chars()
                    .all(|c| c == character || markdown_whitespace(c))
            {
                fence = None;
            }
            continue;
        }
        if let Some(character @ ('`' | '~')) = line.chars().next() {
            let length = line.chars().take_while(|c| *c == character).count();
            if length >= 3 {
                paragraph_break = true;
                fence = Some((character, length));
                continue;
            }
        }
        let level = line.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&level)
            && line[level..]
                .chars()
                .next()
                .is_some_and(markdown_whitespace)
        {
            paragraph_break = true;
            let name = line[level..]
                .trim_matches(markdown_whitespace)
                .trim_end_matches('#')
                .trim_matches(markdown_whitespace);
            if level == 3 && section == "discussion outline" {
                if name.len() > 8_000 {
                    return Err("brief outline title exceeds 8,000 bytes".into());
                }
                if agenda.len() >= 20 {
                    return Err("brief has more than 20 discussion sections".into());
                }
                agenda.push(OutlineSection {
                    id: Uuid::new_v4(),
                    title: name.to_owned(),
                    objective: String::new(),
                    talking_points: Vec::new(),
                    keywords: Vec::new(),
                    order: agenda.len() as u32 + 1,
                });
            } else if level == 2 {
                section = name.to_lowercase();
            } else {
                section.clear();
            }
            continue;
        }
        if line.is_empty() {
            paragraph_break = true;
            continue;
        }
        if !matches!(
            section.as_str(),
            "objective"
                | "positions"
                | "priorities"
                | "discussion outline"
                | "desired outcomes"
                | "questions to ask"
                | "red lines"
                | "prohibited claims"
                | "unauthorized commitments"
                | "risks"
                | "watch for"
        ) {
            continue;
        }
        policy_lines += 1;
        if policy_lines > 2_000 || line.len() > 8_000 {
            return Err("brief policy exceeds 2,000 lines or 8,000 bytes per item".into());
        }
        let item = line
            .strip_prefix("- ")
            .or_else(|| line.strip_prefix("* "))
            .or_else(|| line.strip_prefix("+ "))
            .unwrap_or(line);
        if section == "discussion outline" {
            if let Some(current) = agenda.last_mut() {
                if item != line {
                    current.talking_points.push(item.to_owned());
                } else {
                    if !current.objective.is_empty() {
                        current.objective.push(' ');
                    }
                    current.objective.push_str(item);
                    if current.objective.len() > 8_000 {
                        return Err("brief outline objective exceeds 8,000 bytes".into());
                    }
                }
            }
        } else {
            let entries = sections.entry(section.clone()).or_default();
            if item != line
                || entries.is_empty()
                || (paragraph_break && !raw.starts_with([' ', '\t']))
            {
                entries.push(item.to_owned());
            } else if let Some(previous) = entries.last_mut() {
                previous.push(' ');
                previous.push_str(item);
            }
            if entries.last().is_some_and(|item| item.len() > 8_000) {
                return Err("brief policy exceeds 8,000 bytes per item".into());
            }
        }
        paragraph_break = false;
    }
    let take = |sections: &mut HashMap<String, Vec<String>>, name: &str| {
        sections.remove(name).unwrap_or_default()
    };
    brief.objective = take(&mut sections, "objective").join("\n");
    brief.our_position.clear();
    brief.client_position.clear();
    for position in take(&mut sections, "positions") {
        if let Some(value) = position.strip_prefix("**Our position:** ") {
            brief.our_position = value.to_owned();
        }
        if let Some(value) = position.strip_prefix("**Client position:** ") {
            brief.client_position = value.to_owned();
        }
    }
    brief.priorities = take(&mut sections, "priorities");
    brief.agenda = agenda;
    brief.desired_outcomes = take(&mut sections, "desired outcomes");
    brief.questions_to_ask = take(&mut sections, "questions to ask");
    brief.red_lines = take(&mut sections, "red lines");
    brief.prohibited_claims = take(&mut sections, "prohibited claims");
    brief.unauthorized_commitments = take(&mut sections, "unauthorized commitments");
    brief.risks = take(&mut sections, "risks");
    brief.risks.extend(take(&mut sections, "watch for"));
    // Changed source cannot retain old evidence bindings or invisible instructions.
    // Their full text remains in document_content for the provider's context.
    brief.facts_to_use.clear();
    brief.concessions.clear();
    brief.custom_instructions.clear();
    Ok(())
}

pub fn load_reviewed(
    storage: &savvy_storage::Storage,
    brief_id: Uuid,
    client_id: Option<Uuid>,
    expected_hash: Option<&str>,
) -> Result<NegotiationBrief, String> {
    let mut brief = storage
        .get_brief(brief_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "brief does not exist".to_owned())?;
    if brief.client_id != client_id {
        return Err("brief does not belong to the selected client".into());
    }
    if brief.document_content.trim().is_empty() {
        brief.document_content = brief
            .document_path
            .as_deref()
            .map(super::read_brief_document)
            .transpose()?
            .unwrap_or_else(|| super::render_brief_markdown(&brief));
    }
    verify_review(&brief, expected_hash)?;
    synchronize(&mut brief)?;
    Ok(brief)
}

pub fn verify_review(brief: &NegotiationBrief, expected_hash: Option<&str>) -> Result<(), String> {
    if expected_hash != Some(super::sha256(&brief.document_content).as_str()) {
        return Err(
            "The brief changed or has not been reviewed. Go back and review it before starting."
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn meeting_load_reconciles_persisted_legacy_policy_and_rejects_unreviewed_changes() {
        let storage = savvy_storage::Storage::in_memory().unwrap();
        let mut brief = crate::imported_brief(
            None,
            1,
            "review.md".into(),
            "## Red lines\n- Current limit".into(),
            "en".into(),
        );
        brief.red_lines = vec!["Removed limit".into()];
        storage.save_brief(&brief).unwrap();
        let hash = crate::sha256(&brief.document_content);
        assert_eq!(
            load_reviewed(&storage, brief.id, None, Some(&hash))
                .unwrap()
                .red_lines,
            ["Current limit"]
        );
        assert!(load_reviewed(&storage, brief.id, None, None).is_err());
        assert!(load_reviewed(&storage, brief.id, Some(Uuid::new_v4()), Some(&hash)).is_err());
        brief.document_content = "## Red lines\n- Changed after readiness".into();
        storage.save_brief(&brief).unwrap();
        assert!(load_reviewed(&storage, brief.id, None, Some(&hash)).is_err());
        assert_eq!(
            load_reviewed(
                &storage,
                brief.id,
                None,
                Some(&crate::sha256(&brief.document_content))
            )
            .unwrap()
            .red_lines,
            ["Changed after readiness"]
        );
    }

    #[test]
    fn edited_and_imported_policy_replaces_stale_constraints_and_binds_review() {
        let mut brief = crate::imported_brief(None, 1, "review.md".into(), "## Red lines\n- No discount\n## Prohibited claims\n- No guaranteed return\n## Unauthorized commitments\n- No delivery date\n## Risks\n- Renewal delay\n## Discussion outline\n### Timing\nAgree a date\n- Ask about dependencies".into(), "en".into());
        brief.red_lines = vec!["Obsolete restriction".into()];
        synchronize(&mut brief).unwrap();
        assert_eq!(brief.red_lines, ["No discount"]);
        assert_eq!(brief.prohibited_claims, ["No guaranteed return"]);
        assert_eq!(brief.unauthorized_commitments, ["No delivery date"]);
        assert_eq!(brief.risks, ["Renewal delay"]);
        assert_eq!(brief.agenda[0].talking_points, ["Ask about dependencies"]);
        let turn = savvy_domain::TranscriptTurn {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            channel: savvy_domain::SpeakerChannel::SelfSpeaker,
            text: "A discount is requested.".into(),
            language: "en".into(),
            start_ms: 0,
            end_ms: 1000,
            is_final: true,
            confidence: 1.0,
        };
        assert_eq!(
            crate::TriggerDetector::new(brief.red_lines.clone()).detect(&turn),
            Some(savvy_domain::Trigger::Risk)
        );
        assert_eq!(
            crate::recommend_from_hard_constraint(&brief, &turn, savvy_domain::Trigger::Risk, None)
                .unwrap()
                .avoid
                .as_deref(),
            Some("No discount")
        );
        let mut canonical = brief.clone();
        canonical.document_content = crate::render_brief_markdown(&canonical);
        let unchanged = canonical.clone();
        synchronize(&mut canonical).unwrap();
        assert_eq!(canonical, unchanged);
        assert_eq!(
            crate::sha256("Reviewed brief\nNo discount\nCatalà"),
            "01b76b0399cd35e10d594373c72656a3ff97533a26798293fb689aab604ff9b7"
        );
        let reviewed = crate::sha256(&brief.document_content);
        verify_review(&brief, Some(&reviewed)).unwrap();
        assert!(verify_review(&brief, None).is_err());
        brief.document_content =
            "# Red lines\nUnsupported heading level\n```md\n## Red lines\n- Example only\n```"
                .into();
        synchronize(&mut brief).unwrap();
        assert!(brief.red_lines.is_empty());
        assert!(brief.prohibited_claims.is_empty());
        assert!(brief.unauthorized_commitments.is_empty());
        assert!(brief.agenda.is_empty());
        assert!(brief.risks.is_empty());
        assert!(crate::TriggerDetector::new(brief.red_lines.clone())
            .detect(&turn)
            .is_none());
        assert!(crate::recommend_from_hard_constraint(
            &brief,
            &turn,
            savvy_domain::Trigger::Risk,
            None
        )
        .is_none());
        assert!(verify_review(&brief, Some(&reviewed)).is_err());
        brief.document_content = "##\u{a0}Red lines\n- Do not discount\n  unless approved.\n\nA second constraint\nwith its condition.".into();
        synchronize(&mut brief).unwrap();
        assert_eq!(
            brief.red_lines,
            [
                "Do not discount unless approved.",
                "A second constraint with its condition."
            ]
        );
        for whitespace in ['\u{a0}', '\u{feff}', '\u{2003}', '\u{202f}'] {
            brief.document_content = format!("##{whitespace}Red lines{whitespace}\n- No discount");
            synchronize(&mut brief).unwrap();
            assert_eq!(brief.red_lines, ["No discount"]);
        }
        brief.document_content = "## Red lines\n".to_owned() + &"- Too many\n".repeat(2001);
        assert!(synchronize(&mut brief).is_err());
        brief.document_content = format!("## Discussion outline\n### {}", "x".repeat(8001));
        assert!(synchronize(&mut brief).is_err());
        brief.document_content = format!(
            "## Discussion outline\n### Topic\n{}\n{}",
            "x".repeat(5000),
            "y".repeat(5000)
        );
        assert!(synchronize(&mut brief).is_err());
    }
}
