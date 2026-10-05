use std::sync::Mutex;
use tokio::sync::watch;
use uuid::Uuid;

pub(crate) const CANCELLED: &str = "brief_cancelled: Brief generation was cancelled.";

#[derive(Clone, Copy, Default, serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Stage {
    #[default]
    Reading,
    Drafting,
    Saving,
}

#[derive(Default)]
struct State {
    committing: bool,
    stage: Stage,
    managed_key: Option<String>,
}

pub(crate) struct BriefJob {
    pub id: Uuid,
    signal: watch::Sender<bool>,
    state: Mutex<State>,
}

impl BriefJob {
    pub fn new(id: Uuid) -> Self {
        Self {
            id,
            signal: watch::channel(false).0,
            state: Mutex::new(State::default()),
        }
    }

    pub fn signal(&self) -> watch::Receiver<bool> {
        self.signal.subscribe()
    }

    pub fn check(&self) -> Result<(), String> {
        if *self.signal.borrow() {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }

    pub fn stage(&self) -> Result<Stage, String> {
        Ok(self.state.lock().map_err(|_| "brief job lock")?.stage)
    }

    pub fn drafting(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "brief job lock")?;
        self.check()?;
        state.stage = Stage::Drafting;
        Ok(())
    }

    pub fn bind_managed_key(&self, key: &str) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "brief job lock")?;
        self.check()?;
        if state.committing || state.managed_key.is_some() {
            return Err("brief job is already submitted".into());
        }
        state.managed_key = Some(key.to_owned());
        Ok(())
    }

    pub fn cancel(&self) -> Result<Option<String>, String> {
        let state = self.state.lock().map_err(|_| "brief job lock")?;
        if state.committing {
            return Err("Brief already completed; its result is being saved.".into());
        }
        self.signal.send_replace(true);
        Ok(state.managed_key.clone())
    }

    // A paid result that won the server race must still reach durable recovery.
    pub fn commit(&self, preserve_completed: bool) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "brief job lock")?;
        if !preserve_completed {
            self.check()?;
        }
        state.committing = true;
        state.stage = Stage::Saving;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_belongs_to_one_job_and_preserves_completed_paid_results() {
        let first = BriefJob::new(Uuid::new_v4());
        let second = BriefJob::new(Uuid::new_v4());
        assert_eq!(first.stage().unwrap(), Stage::Reading);
        first.drafting().unwrap();
        assert_eq!(first.stage().unwrap(), Stage::Drafting);
        first.bind_managed_key("first-request").unwrap();
        assert_eq!(first.cancel().unwrap().as_deref(), Some("first-request"));
        assert!(*first.signal().borrow());
        assert!(first.commit(false).is_err());
        second.check().unwrap();
        second.bind_managed_key("second-request").unwrap();
        first.commit(true).unwrap();
        assert_eq!(first.stage().unwrap(), Stage::Saving);
        assert!(first.cancel().is_err());
        let before_submission = BriefJob::new(Uuid::new_v4());
        assert_eq!(before_submission.cancel().unwrap(), None);
        assert!(before_submission
            .bind_managed_key("must-not-submit")
            .is_err());
        second.commit(false).unwrap();
        assert!(second.cancel().is_err());
    }
    #[test]
    fn tauri_cancel_rejects_stale_and_cross_scope_jobs() {
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![crate::cancel_brief_draft])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let invoke = |client: Uuid, request: Uuid| {
            tauri::test::get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: "cancel_brief_draft".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(
                        serde_json::json!({"clientId":client,"requestId":request}),
                    ),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
        };
        let client = Uuid::new_v4();
        let first = std::sync::Arc::new(BriefJob::new(Uuid::new_v4()));
        crate::BRIEF_SCOPES
            .lock()
            .unwrap()
            .insert(Some(client), first.clone());
        let _cleanup = crate::BriefScope(Some(client));
        assert!(invoke(Uuid::new_v4(), first.id).is_err());
        assert!(invoke(client, Uuid::new_v4()).is_err());
        first.check().unwrap();
        assert!(invoke(client, first.id).is_ok());
        assert!(first.check().is_err());
        let second = std::sync::Arc::new(BriefJob::new(Uuid::new_v4()));
        crate::BRIEF_SCOPES
            .lock()
            .unwrap()
            .insert(Some(client), second.clone());
        assert!(invoke(client, first.id).is_err());
        second.check().unwrap();
        second.commit(true).unwrap();
        assert!(invoke(client, second.id).is_err());
        second.check().unwrap();
    }
}
