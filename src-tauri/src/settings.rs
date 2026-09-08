use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

pub const DEFAULT_BRIEF_GENERATION_PROMPT: &str = "Create a concise, source-grounded meeting brief. Apply the reusable guidance to the client evidence. Identify objectives, positions, priorities, a practical discussion outline, desired outcomes, questions, factual talking points with citations, concessions, red lines, prohibited claims, unauthorized commitments, and risks. Never invent client facts. Prefer concrete language that can guide a live conversation.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub start_listening_shortcut: String,
    pub selected_microphone: Option<String>,
    pub selected_channel: Option<u16>,
    pub audio_feedback: bool,
    pub selected_output_device: Option<String>,
    pub selected_system_output_device: Option<String>,
    pub audio_feedback_volume: f32,
    pub recommendation_provider: String,
    pub codex_model: String,
    pub codex_service_tier: String,
    pub claude_model: String,
    pub claude_context_window: String,
    pub guidance_folder: Option<String>,
    pub brief_generation_prompt: String,
    pub transcription_provider: String,
    pub transcription_model: String,
    pub transcription_language: String,
    pub start_hidden: bool,
    pub launch_on_startup: bool,
    pub show_tray_icon: bool,
    pub overlay_style: String,
    pub overlay_position: String,
    pub show_live_transcript: bool,
    pub theme: String,
    pub onboarding_completed: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            start_listening_shortcut: if cfg!(target_os = "windows") {
                "Control+Shift+M"
            } else {
                "Command+Shift+M"
            }
            .into(),
            selected_microphone: None,
            selected_channel: None,
            audio_feedback: false,
            selected_output_device: None,
            selected_system_output_device: None,
            audio_feedback_volume: 0.5,
            recommendation_provider: "codex".into(),
            codex_model: "gpt-5.6-sol".into(),
            codex_service_tier: "default".into(),
            claude_model: "claude-sonnet-5".into(),
            claude_context_window: "200k".into(),
            guidance_folder: None,
            brief_generation_prompt: DEFAULT_BRIEF_GENERATION_PROMPT.into(),
            transcription_provider: "deepgram".into(),
            transcription_model: "nova-3".into(),
            transcription_language: "multi".into(),
            start_hidden: false,
            launch_on_startup: false,
            show_tray_icon: true,
            overlay_style: "live".into(),
            overlay_position: "bottom".into(),
            show_live_transcript: false,
            theme: "system".into(),
            onboarding_completed: false,
        }
    }
}

pub fn load(path: &Path) -> AppSettings {
    let Ok(bytes) = fs::read(path) else {
        // Missing or unreadable settings use first-run defaults.
        return AppSettings::default();
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return AppSettings::default();
    };
    let Some(fields) = value.as_object() else {
        return AppSettings::default();
    };
    let has_onboarding_flag = fields.contains_key("onboardingCompleted");
    let mut settings = serde_json::from_value::<AppSettings>(value.clone()).unwrap_or_else(|_| {
        let mut recovered = serde_json::Map::new();
        for (key, value) in fields {
            recovered.insert(key.clone(), value.clone());
            if serde_json::from_value::<AppSettings>(recovered.clone().into()).is_err() {
                recovered.remove(key);
                log::warn!("Ignoring invalid settings field: {key}");
            }
        }
        serde_json::from_value(recovered.into()).unwrap_or_default()
    });
    if !has_onboarding_flag {
        // Settings written before onboarding existed. The install is already in use,
        // so onboarding it now would be a regression for every current user.
        settings.onboarding_completed = true;
    }
    normalize(settings)
}

fn normalize(mut settings: AppSettings) -> AppSettings {
    if settings.transcription_provider == "assemblyAi"
        && settings.transcription_model == "universal-3-5-pro"
    {
        settings.transcription_model = "u3-rt-pro".into();
        settings.transcription_language = "multi".into();
    }
    settings
}

pub fn save(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_settings_receive_transcription_defaults() {
        let settings: AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.transcription_provider, "deepgram");
        assert_eq!(settings.transcription_model, "nova-3");
        assert_eq!(settings.transcription_language, "multi");
        assert_eq!(settings.codex_service_tier, "default");
        assert_eq!(settings.recommendation_provider, "codex");
        assert_eq!(settings.claude_model, "claude-sonnet-5");
        assert_eq!(settings.claude_context_window, "200k");
        assert_eq!(settings.guidance_folder, None);
        assert_eq!(settings.selected_system_output_device, None);
        assert_eq!(
            settings.start_listening_shortcut,
            if cfg!(target_os = "windows") {
                "Control+Shift+M"
            } else {
                "Command+Shift+M"
            }
        );
        assert_eq!(
            settings.brief_generation_prompt,
            DEFAULT_BRIEF_GENERATION_PROMPT
        );
    }

    #[test]
    fn settings_can_be_replaced_without_losing_the_system_output() {
        let directory =
            std::env::temp_dir().join(format!("savvy-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("settings.json");
        let mut settings = AppSettings::default();
        save(&path, &settings).unwrap();
        settings.selected_system_output_device = Some("Meeting headphones".into());
        save(&path, &settings).unwrap();
        assert_eq!(load(&path), settings);
        assert!(!path.with_extension("json.tmp").exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn old_assembly_ai_model_moves_to_current_default() {
        let settings = normalize(AppSettings {
            transcription_provider: "assemblyAi".into(),
            transcription_model: "universal-3-5-pro".into(),
            transcription_language: "nl".into(),
            ..AppSettings::default()
        });
        assert_eq!(settings.transcription_model, "u3-rt-pro");
        assert_eq!(settings.transcription_language, "multi");
    }

    #[test]
    fn invalid_fields_do_not_reset_completed_setup_or_other_preferences() {
        let directory =
            std::env::temp_dir().join(format!("savvy-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("settings.json");
        let stored = br#"{"onboardingCompleted":true,"theme":"dark","selectedMicrophone":"USB mic","audioFeedbackVolume":"bad","selectedChannel":-1,"briefGenerationPrompt":"Keep this prompt","transcriptionProvider":"assemblyAi","transcriptionModel":"universal-3-5-pro"}"#;
        fs::write(&path, stored).unwrap();
        let settings = load(&path);
        assert!(settings.onboarding_completed);
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.selected_microphone.as_deref(), Some("USB mic"));
        assert_eq!(settings.audio_feedback_volume, 0.5);
        assert_eq!(settings.selected_channel, None);
        assert_eq!(settings.brief_generation_prompt, "Keep this prompt");
        assert_eq!(settings.transcription_model, "u3-rt-pro");
        assert_eq!(fs::read(&path).unwrap(), stored);
        for invalid in ["null", "[]", "{broken"] {
            fs::write(&path, invalid).unwrap();
            assert!(!load(&path).onboarding_completed);
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn onboarding_only_runs_for_installs_without_settings() {
        let directory =
            std::env::temp_dir().join(format!("savvy-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("settings directory");
        let path = directory.join("settings.json");

        // Fresh install: no file at all.
        assert!(!load(&path).onboarding_completed);

        // Existing install whose settings predate onboarding. Onboarding it now would
        // interrupt a user who is already set up.
        fs::write(&path, br#"{"startListeningShortcut":"Command+Shift+M"}"#)
            .expect("legacy settings");
        assert!(load(&path).onboarding_completed);

        // Once written, the stored value is respected in both directions.
        fs::write(&path, br#"{"onboardingCompleted":false}"#).expect("pending settings");
        assert!(!load(&path).onboarding_completed);

        fs::remove_dir_all(directory).expect("remove settings directory");
    }
}
