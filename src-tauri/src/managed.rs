//! Managed account: browser authorization with PKCE, token cache, and service calls.
//!
//! Errors crossing the Tauri boundary are strings; managed failures use a
//! stable `code: message` shape so the UI can branch on the code while BYOK
//! errors stay free-form. The refresh token lives in the platform credential
//! store under its own service name; access tokens stay in process memory only.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

pub const SIGN_IN_REQUIRED: &str = "sign_in_required";

/// Credential-store service for the managed refresh token, distinct from the
/// transcription-key service so BYOK keys and account credentials never mix.
#[cfg(all(any(target_os = "macos", target_os = "windows"), not(test)))]
pub const MANAGED_KEYCHAIN_SERVICE: &str = "com.alamaslabs.savvy.managed";

pub fn typed_error(code: &str, message: &str) -> String {
    format!("{code}: {message}")
}

pub fn sign_in_required_error() -> String {
    typed_error(
        SIGN_IN_REQUIRED,
        "Sign in to your Savvy account in Settings before using Savvy managed.",
    )
}

/// Service and issuer endpoints. Environment variables exist for local
/// development against a locally run backend and fake issuer; release
/// builds fall back to the production constants.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManagedConfig {
    pub service_url: String,
    pub issuer_url: String,
    pub client_id: String,
    pub audience: String,
}

pub fn config() -> Result<ManagedConfig, String> {
    #[cfg(test)]
    if let Some(context) = test_context() {
        return Ok(context.config);
    }

    let value = |name: &str, default: &str| {
        if cfg!(feature = "local-integration") {
            return match name {
                "SAVVY_SERVICE_URL" => option_env!("SAVVY_SERVICE_URL"),
                "SAVVY_OIDC_ISSUER" => option_env!("SAVVY_OIDC_ISSUER"),
                "SAVVY_OIDC_CLIENT_ID" => option_env!("SAVVY_OIDC_CLIENT_ID"),
                "SAVVY_OIDC_AUDIENCE" => option_env!("SAVVY_OIDC_AUDIENCE"),
                _ => None,
            }
            .unwrap_or(default)
            .to_owned();
        }
        if !cfg!(debug_assertions) {
            return default.to_owned();
        }
        std::env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| default.to_owned())
    };
    let config = ManagedConfig {
        service_url: value("SAVVY_SERVICE_URL", "https://api.savvycopilot.com"),
        issuer_url: value("SAVVY_OIDC_ISSUER", "https://api.savvycopilot.com"),
        client_id: value("SAVVY_OIDC_CLIENT_ID", "savvy-desktop"),
        audience: value("SAVVY_OIDC_AUDIENCE", "https://api.savvycopilot.com"),
    };
    for url in [&config.service_url, &config.issuer_url] {
        require_trusted_url(url)?;
    }
    Ok(config)
}

/// Production tokens only ever travel over HTTPS; plain HTTP is allowed for
/// loopback development servers alone.
fn require_trusted_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "invalid managed URL".to_owned())?;
    let loopback = parsed.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || !(parsed.scheme() == "https"
            || ((cfg!(debug_assertions) || cfg!(feature = "local-integration"))
                && parsed.scheme() == "http"
                && loopback))
    {
        return Err("managed URLs require HTTPS or an exact development loopback host".into());
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum FundingChoice {
    Personal {},
    Organization {
        #[serde(rename = "organizationId")]
        organization_id: String,
    },
}
impl FundingChoice {
    pub fn validate(&self) -> Result<(), String> {
        if let Self::Organization { organization_id } = self {
            if !organization_id
                .parse::<i64>()
                .is_ok_and(|id| id > 0 && id.to_string() == *organization_id)
            {
                return Err(typed_error(
                    "invalid_request",
                    "Invalid organization identity.",
                ));
            }
        }
        Ok(())
    }
}
#[derive(Clone, PartialEq, Eq)]
struct FundingBinding {
    choice: FundingChoice,
    identity: Option<(String, String)>,
    generation: u64,
}
static FUNDING_PREFERENCES: LazyLock<Mutex<serde_json::Value>> =
    LazyLock::new(|| Mutex::new(serde_json::json!({})));
static SESSION_FUNDING: LazyLock<Mutex<HashMap<String, FundingBinding>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub fn configure_funding_preferences(value: serde_json::Value) {
    if let Ok(mut preferences) = FUNDING_PREFERENCES.lock() {
        *preferences = value;
    }
}
fn preference_key(identity: &(String, String)) -> Result<String, String> {
    serde_json::to_string(identity).map_err(|_| "Invalid verified identity.".into())
}
fn selected_funding() -> Result<FundingChoice, String> {
    let identity = ACCOUNT_IDENTITY
        .lock()
        .map_err(|_| "identity lock")?
        .clone();
    let preferences = FUNDING_PREFERENCES.lock().map_err(|_| "funding lock")?;
    funding_for_identity(&preferences, identity.as_ref())
}
fn funding_for_identity(
    preferences: &serde_json::Value,
    identity: Option<&(String, String)>,
) -> Result<FundingChoice, String> {
    let values = preferences.as_object().ok_or_else(|| {
        typed_error(
            "funding_unavailable",
            "The saved funding preference is invalid. Choose a payer again.",
        )
    })?;
    let Some(identity) = identity else {
        return if values.is_empty() {
            Ok(FundingChoice::Personal {})
        } else {
            Err(sign_in_required_error())
        };
    };
    let choice = match values.get(&preference_key(identity)?) {
        None if values.contains_key("__invalid_preferences") => {
            return Err(typed_error(
                "funding_unavailable",
                "Choose a payer again for this identity.",
            ));
        }
        None => FundingChoice::Personal {},
        Some(value) => serde_json::from_value(value.clone()).map_err(|_| {
            typed_error(
                "funding_unavailable",
                "The saved funding preference is invalid. Choose a payer again.",
            )
        })?,
    };
    choice.validate()?;
    Ok(choice)
}
fn funding_binding() -> Result<FundingBinding, String> {
    Ok(FundingBinding {
        choice: selected_funding()?,
        identity: ACCOUNT_IDENTITY
            .lock()
            .map_err(|_| "identity lock")?
            .clone(),
        generation: AUTH_GENERATION.load(Ordering::SeqCst),
    })
}
pub(crate) fn funding_selection(expected: Option<&FundingChoice>) -> Result<FundingChoice, String> {
    ensure_signed_in()?;
    if ACCOUNT_IDENTITY
        .lock()
        .map_err(|_| "identity lock")?
        .is_none()
    {
        account_summary()?;
    }
    let choice = selected_funding()?;
    if expected.is_some_and(|value| *value != choice) {
        return Err(typed_error(
            "funding_mismatch",
            "Funding changed while preparing. Review and start again.",
        ));
    }
    Ok(choice)
}
pub fn funding_snapshot(expected: Option<&FundingChoice>) -> Result<FundingChoice, String> {
    let choice = funding_selection(expected)?;
    if let FundingChoice::Organization { organization_id } = &choice {
        let summary = account_summary()?;
        if summary.get("organization").is_none() {
            return Err(typed_error(
                "funding_unavailable",
                "Update the Savvy service before using an organization seat.",
            ));
        }
        if summary["organization"]["id"].as_str() != Some(organization_id.as_str())
            || !summary["organization"]["assignmentId"].is_string()
            || !summary["organizationAllowance"].is_object()
        {
            return Err(typed_error("no_seat", "Your organization seat is unavailable. Choose personal funding explicitly to use personal credit."));
        }
    }
    Ok(choice)
}
pub fn set_funding(
    choice: FundingChoice,
    persist: impl FnOnce(&str, serde_json::Value) -> Result<(), String>,
) -> Result<(), String> {
    choice.validate()?;
    account_summary()?;
    let identity = ACCOUNT_IDENTITY
        .lock()
        .map_err(|_| "identity lock")?
        .clone()
        .ok_or_else(sign_in_required_error)?;
    // Validate a new seat before taking the commit lock; the server rechecks it on every spend.
    if let FundingChoice::Organization { organization_id } = &choice {
        let summary = service_get("/v1/account")?;
        if summary["organization"]["id"].as_str() != Some(organization_id)
            || !summary["organization"]["assignmentId"].is_string()
            || !summary["organizationAllowance"].is_object()
        {
            return Err(typed_error(
                "no_seat",
                "You do not have an available organization seat.",
            ));
        }
    }
    let _guard = REFRESH_LOCK.lock().map_err(|_| "credential lock")?;
    if ACCOUNT_IDENTITY
        .lock()
        .map_err(|_| "identity lock")?
        .as_ref()
        != Some(&identity)
    {
        return Err(sign_in_required_error());
    }
    if SERVICE_OPERATIONS.load(Ordering::SeqCst) > 0
        || !SESSION_FUNDING
            .lock()
            .map_err(|_| "funding lock")?
            .is_empty()
        || !BRIEF_RETRY
            .lock()
            .map_err(|_| "brief retry lock")?
            .is_empty()
        || !COMPLETED_BRIEFS
            .lock()
            .map_err(|_| "brief recovery lock")?
            .is_empty()
    {
        return Err(typed_error(
            "funding_mismatch",
            "End the meeting and finish or cancel pending briefs before changing funding.",
        ));
    }
    let key = preference_key(&identity)?;
    let value = serde_json::to_value(&choice).map_err(|_| "Invalid funding choice.")?;
    persist(&key, value.clone())?;
    let mut preferences = FUNDING_PREFERENCES.lock().map_err(|_| "funding lock")?;
    if !preferences.is_object() {
        *preferences = serde_json::json!({"__invalid_preferences":true});
    }
    preferences
        .as_object_mut()
        .ok_or("funding preferences")?
        .insert(key, value);
    Ok(())
}
fn brief_digest(
    request: &savvy_providers::BriefWireRequest,
    binding: &FundingBinding,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let encoded = serde_json::to_vec(&(request, &binding.identity, &binding.choice))
        .map_err(|_| "invalid brief request")?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}
pub(crate) fn brief_recovery_binding() -> Result<serde_json::Value, String> {
    let binding = funding_binding()?;
    let identity = binding.identity.ok_or_else(sign_in_required_error)?;
    Ok(serde_json::json!({"identity":identity,"funding":binding.choice}))
}

struct CachedToken {
    access_token: String,
    expires_at: Instant,
}

static ACCOUNT_IDENTITY: Mutex<Option<(String, String)>> = Mutex::new(None);
static SERVICE_OPERATIONS: AtomicU64 = AtomicU64::new(0);
static AUDIO_CHECK_OPERATIONS: AtomicU64 = AtomicU64::new(0);
pub(crate) struct ServiceOperation {
    audio_check: bool,
}
impl ServiceOperation {
    pub(crate) fn begin() -> Result<Self, String> {
        Self::register(false)
    }
    #[cfg(any(target_os = "macos", target_os = "windows", test))]
    pub(crate) fn begin_audio_check() -> Result<Self, String> {
        Self::register(true)
    }
    fn register(audio_check: bool) -> Result<Self, String> {
        let _guard = REFRESH_LOCK.lock().map_err(|_| "credential lock")?;
        SERVICE_OPERATIONS.fetch_add(1, Ordering::SeqCst);
        if audio_check {
            AUDIO_CHECK_OPERATIONS.fetch_add(1, Ordering::SeqCst);
        }
        Ok(Self { audio_check })
    }
}
fn require_audio_check_finished() -> Result<(), String> {
    if AUDIO_CHECK_OPERATIONS.load(Ordering::SeqCst) > 0 {
        return Err("Stop the audio check before signing out.".into());
    }
    Ok(())
}
impl Drop for ServiceOperation {
    fn drop(&mut self) {
        if self.audio_check {
            AUDIO_CHECK_OPERATIONS.fetch_sub(1, Ordering::SeqCst);
        }
        SERVICE_OPERATIONS.fetch_sub(1, Ordering::SeqCst);
    }
}
fn clear_account_state() {
    if let Ok(mut value) = SESSION_FUNDING.lock() {
        value.clear();
    }
    if let Ok(mut value) = COMPLETED_BRIEFS.lock() {
        value.clear();
    }
    if let Ok(mut value) = PREPARED.lock() {
        value.clear();
    }
    if let Ok(mut value) = SESSION_VIEWS.lock() {
        value.clear();
    }
    if let Ok(mut value) = BRIEF_RETRY.lock() {
        value.clear();
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct PendingRevocation {
    config: ManagedConfig,
    token: String,
}
static REVOCATION_QUEUE_LOCK: Mutex<()> = Mutex::new(());
static REVOCATION_WORKER_LOCK: Mutex<()> = Mutex::new(());

#[cfg(all(target_os = "macos", not(test)))]
fn read_revocations() -> Result<Vec<PendingRevocation>, String> {
    match security_framework::passwords::get_generic_password(
        MANAGED_KEYCHAIN_SERVICE,
        "pending-revocations-v1",
    ) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "invalid pending revocation record".into())
        }
        Err(error) if error.code() == -25_300 => Ok(vec![]),
        Err(_) => Err("could not read pending revocations from Keychain".into()),
    }
}
#[cfg(all(target_os = "macos", not(test)))]
fn write_revocations(records: &[PendingRevocation]) -> Result<(), String> {
    let bytes = serde_json::to_vec(records).map_err(|_| "invalid pending revocation record")?;
    security_framework::passwords::set_generic_password(
        MANAGED_KEYCHAIN_SERVICE,
        "pending-revocations-v1",
        &bytes,
    )
    .map_err(|_| "could not save pending revocations in Keychain".into())
}
#[cfg(test)]
fn read_revocations() -> Result<Vec<PendingRevocation>, String> {
    Ok(test_context()
        .map(|context| context.revocations.lock().unwrap().clone())
        .unwrap_or_default())
}
#[cfg(test)]
fn write_revocations(records: &[PendingRevocation]) -> Result<(), String> {
    let context = test_context().ok_or("test credential store not installed")?;
    if context.revocation_write_failure.load(Ordering::SeqCst) {
        return Err("fixture Keychain write failure".into());
    }
    *context.revocations.lock().unwrap() = records.to_vec();
    Ok(())
}
#[cfg(all(target_os = "windows", not(test)))]
fn read_revocations() -> Result<Vec<PendingRevocation>, String> {
    match crate::credentials::get_for(MANAGED_KEYCHAIN_SERVICE, "pending-revocations-v1")? {
        Some(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "invalid pending revocation record".into())
        }
        None => Ok(vec![]),
    }
}
#[cfg(all(target_os = "windows", not(test)))]
fn write_revocations(records: &[PendingRevocation]) -> Result<(), String> {
    let bytes = serde_json::to_vec(records).map_err(|_| "invalid pending revocation record")?;
    crate::credentials::set_for(MANAGED_KEYCHAIN_SERVICE, "pending-revocations-v1", &bytes)
}
#[cfg(all(not(any(target_os = "macos", target_os = "windows")), not(test)))]
fn read_revocations() -> Result<Vec<PendingRevocation>, String> {
    Ok(vec![])
}
#[cfg(all(not(any(target_os = "macos", target_os = "windows")), not(test)))]
fn write_revocations(_records: &[PendingRevocation]) -> Result<(), String> {
    Err("secure credential storage is available on macOS".into())
}
fn queue_revocation(config: ManagedConfig, token: String) -> Result<(), String> {
    let _guard = REVOCATION_QUEUE_LOCK
        .lock()
        .map_err(|_| "revocation queue lock")?;
    let mut records = read_revocations()?;
    let record = PendingRevocation { config, token };
    if !records.contains(&record) {
        if records.len() >= 128 {
            return Err("Reconnect to finish pending sign-outs before continuing.".into());
        }
        records.push(record);
        write_revocations(&records)?;
    }
    Ok(())
}
fn drain_revocations() -> Result<(), String> {
    let _worker = REVOCATION_WORKER_LOCK
        .lock()
        .map_err(|_| "revocation worker lock")?;
    let records = {
        let _guard = REVOCATION_QUEUE_LOCK
            .lock()
            .map_err(|_| "revocation queue lock")?;
        read_revocations()?
    };
    for record in records {
        let attempt = (|| {
            require_trusted_url(&record.config.issuer_url)?;
            let metadata = discovery(&record.config)?;
            let response = http()?
                .post(metadata.revocation_endpoint)
                .form(&[
                    ("client_id", record.config.client_id.as_str()),
                    ("token", record.token.as_str()),
                    ("token_type_hint", "refresh_token"),
                ])
                .send()
                .map_err(|_| "revocation unavailable")?;
            if !response.status().is_success() {
                return Err("revocation unavailable".into());
            }
            Ok::<(), String>(())
        })();
        if attempt.is_ok() {
            let _credentials = REFRESH_LOCK.lock().map_err(|_| "credential lock")?;
            if config()? == record.config && read_refresh_token()?.as_ref() == Some(&record.token) {
                delete_refresh_token()?;
            }
            let _guard = REVOCATION_QUEUE_LOCK
                .lock()
                .map_err(|_| "revocation queue lock")?;
            let mut current = read_revocations()?;
            current.retain(|pending| pending != &record);
            write_revocations(&current)?;
        }
    }
    Ok(())
}
fn retry_revocations() {
    #[cfg(test)]
    let context = test_context();
    std::thread::spawn(move || {
        #[cfg(test)]
        TEST_CONTEXT.with(|current| *current.borrow_mut() = context);
        let _ = drain_revocations();
    });
}
pub fn start_revocation_worker() {
    std::thread::spawn(|| loop {
        let _ = drain_revocations();
        std::thread::sleep(Duration::from_secs(60));
    });
}
fn revoke_refresh(config: ManagedConfig, token: String) -> Result<(), String> {
    queue_revocation(config, token)?;
    retry_revocations();
    Ok(())
}

static AUTH_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(test)]
struct DeviceFlow {
    code: String,
    expires: Instant,
    interval: u64,
    generation: u64,
}
#[cfg(test)]
static DEVICE_FLOWS: LazyLock<Mutex<HashMap<String, DeviceFlow>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static REFRESH_LOCK: Mutex<()> = Mutex::new(());
static ACCESS_TOKEN: Mutex<Option<CachedToken>> = Mutex::new(None);

fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())
}

#[cfg(all(any(target_os = "macos", target_os = "windows"), not(test)))]
fn credential_account() -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let c = config()?;
    Ok(format!(
        "refresh-{:x}",
        Sha256::digest(
            format!(
                "{}\n{}\n{}\n{}",
                c.issuer_url, c.client_id, c.audience, c.service_url
            )
            .as_bytes()
        )
    ))
}

// --- Keychain-backed refresh token ------------------------------------------

// A crash after enqueueing but before deletion must not restore authorization.
pub fn stored_refresh_token() -> Result<Option<String>, String> {
    let token = read_refresh_token()?;
    if let Some(value) = token.as_ref() {
        let configuration = config()?;
        let _guard = REVOCATION_QUEUE_LOCK
            .lock()
            .map_err(|_| "revocation queue lock")?;
        if read_revocations()?
            .iter()
            .any(|record| record.config == configuration && record.token == *value)
        {
            return Ok(None);
        }
    }
    Ok(token)
}

#[cfg(all(target_os = "macos", not(test)))]
fn read_refresh_token() -> Result<Option<String>, String> {
    use security_framework::passwords::get_generic_password;
    match get_generic_password(MANAGED_KEYCHAIN_SERVICE, &credential_account()?) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "stored Savvy credential is not valid UTF-8".into()),
        Err(error) if error.code() == -25_300 => Ok(None),
        Err(error) => Err(format!(
            "could not read the Savvy account credential: {error}"
        )),
    }
}

#[cfg(all(target_os = "macos", not(test)))]
fn store_refresh_token(token: &str) -> Result<(), String> {
    use security_framework::passwords::set_generic_password;
    set_generic_password(
        MANAGED_KEYCHAIN_SERVICE,
        &credential_account()?,
        token.as_bytes(),
    )
    .map_err(|error| format!("could not save the Savvy account credential: {error}"))
}

#[cfg(all(target_os = "macos", not(test)))]
fn delete_refresh_token() -> Result<(), String> {
    use security_framework::passwords::delete_generic_password;
    match delete_generic_password(MANAGED_KEYCHAIN_SERVICE, &credential_account()?) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25_300 => Ok(()),
        Err(error) => Err(format!(
            "could not remove the Savvy account credential: {error}"
        )),
    }
}

#[cfg(test)]
#[derive(Clone)]
struct TestContext {
    config: ManagedConfig,
    credential: std::sync::Arc<Mutex<Option<String>>>,
    revocations: std::sync::Arc<Mutex<Vec<PendingRevocation>>>,
    revocation_write_failure: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
#[cfg(test)]
thread_local! { static TEST_CONTEXT: std::cell::RefCell<Option<TestContext>> = const {std::cell::RefCell::new(None)}; }
// Only the isolated opt-in IPC test installs this fallback. Async Tauri commands
// execute on runtime workers rather than the test's thread-local credential store.
#[cfg(test)]
static ASYNC_TEST_CONTEXT: Mutex<Option<TestContext>> = Mutex::new(None);
#[cfg(test)]
fn test_context() -> Option<TestContext> {
    TEST_CONTEXT
        .with(|context| context.borrow().clone())
        .or_else(|| ASYNC_TEST_CONTEXT.lock().unwrap().clone())
}

#[cfg(test)]
pub(crate) fn install_connected_e2e_service(url: &str, access_token: &str) {
    *ASYNC_TEST_CONTEXT.lock().unwrap() = Some(TestContext {
        config: ManagedConfig {
            service_url: url.into(),
            issuer_url: url.into(),
            client_id: "connected-e2e".into(),
            audience: "connected-e2e".into(),
        },
        credential: std::sync::Arc::new(Mutex::new(Some("synthetic-refresh".into()))),
        revocations: std::sync::Arc::new(Mutex::new(vec![])),
        revocation_write_failure: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    });
    *ACCESS_TOKEN.lock().unwrap() = Some(CachedToken {
        access_token: access_token.into(),
        expires_at: Instant::now() + Duration::from_secs(120),
    });
}

#[cfg(test)]
pub(crate) fn clear_connected_e2e_service() {
    *ASYNC_TEST_CONTEXT.lock().unwrap() = None;
    *ACCESS_TOKEN.lock().unwrap() = None;
}

#[cfg(test)]
fn read_refresh_token() -> Result<Option<String>, String> {
    Ok(test_context().and_then(|context| context.credential.lock().unwrap().clone()))
}
#[cfg(all(target_os = "windows", not(test)))]
fn read_refresh_token() -> Result<Option<String>, String> {
    crate::credentials::get_for(MANAGED_KEYCHAIN_SERVICE, &credential_account()?)?
        .map(|bytes| {
            String::from_utf8(bytes)
                .map_err(|_| "stored Savvy credential is not valid UTF-8".into())
        })
        .transpose()
}
#[cfg(all(not(any(target_os = "macos", target_os = "windows")), not(test)))]
fn read_refresh_token() -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(test)]
fn store_refresh_token(token: &str) -> Result<(), String> {
    let context = test_context().ok_or("test credential store not installed")?;
    *context.credential.lock().unwrap() = Some(token.to_owned());
    Ok(())
}
#[cfg(all(target_os = "windows", not(test)))]
fn store_refresh_token(token: &str) -> Result<(), String> {
    crate::credentials::set_for(
        MANAGED_KEYCHAIN_SERVICE,
        &credential_account()?,
        token.as_bytes(),
    )
}
#[cfg(all(not(any(target_os = "macos", target_os = "windows")), not(test)))]
fn store_refresh_token(_token: &str) -> Result<(), String> {
    Err("secure credential storage is available on macOS".into())
}

#[cfg(test)]
fn delete_refresh_token() -> Result<(), String> {
    if let Some(context) = test_context() {
        *context.credential.lock().unwrap() = None;
    }
    Ok(())
}
#[cfg(all(target_os = "windows", not(test)))]
fn delete_refresh_token() -> Result<(), String> {
    crate::credentials::delete_for(MANAGED_KEYCHAIN_SERVICE, &credential_account()?)
}
#[cfg(all(not(any(target_os = "macos", target_os = "windows")), not(test)))]
fn delete_refresh_token() -> Result<(), String> {
    Ok(())
}

/// Preflight for managed operations: a stored account credential must exist.
/// The hosted service remains authoritative; this only prevents doomed calls.
pub fn ensure_signed_in() -> Result<(), String> {
    if stored_refresh_token()?.is_some() {
        Ok(())
    } else {
        Err(sign_in_required_error())
    }
}

static SIGN_IN_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    revocation_endpoint: String,
    jwks_uri: String,
}
const MAX_AUTH_RESPONSE_BYTES: usize = 65_536;
// Generated briefs/advice share the backend's 1 MiB structured-response ceiling.
const MAX_SERVICE_RESPONSE_BYTES: usize = 1_048_576;

fn bounded_json<T: serde::de::DeserializeOwned>(
    response: reqwest::blocking::Response,
    limit: usize,
) -> Result<T, String> {
    use std::io::Read;
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("upstream JSON response exceeds its byte limit".into());
    }
    let mut bytes = Vec::new();
    response
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "could not read upstream JSON response")?;
    if bytes.len() > limit {
        return Err("upstream JSON response exceeds its byte limit".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid upstream JSON response".into())
}

fn discovery(config: &ManagedConfig) -> Result<Discovery, String> {
    let metadata: Discovery = bounded_json(
        http()?
            .get(format!(
                "{}/.well-known/openid-configuration",
                config.issuer_url.trim_end_matches('/')
            ))
            .send()
            .map_err(|_| "sign-in service unavailable")?
            .error_for_status()
            .map_err(|_| "sign-in discovery unavailable")?,
        MAX_AUTH_RESPONSE_BYTES,
    )
    .map_err(|_| "invalid sign-in discovery")?;
    if metadata.issuer != config.issuer_url {
        return Err("unexpected sign-in issuer".into());
    }
    let issuer = reqwest::Url::parse(&config.issuer_url).map_err(|_| "invalid issuer")?;
    for endpoint in [
        &metadata.authorization_endpoint,
        &metadata.token_endpoint,
        &metadata.revocation_endpoint,
        &metadata.jwks_uri,
    ] {
        require_trusted_url(endpoint)?;
        let url = reqwest::Url::parse(endpoint).map_err(|_| "invalid endpoint")?;
        if url.origin() != issuer.origin() {
            return Err("untrusted sign-in endpoint".into());
        }
    }
    Ok(metadata)
}

const CALLBACK: &str = "com.alamaslabs.savvy:/oauth/callback";
#[derive(Clone)]
struct BrowserFlow {
    processing: bool,
    credentials_accepted: bool,
    id: String,
    state: String,
    verifier: String,
    expires: Instant,
    generation: u64,
    config: ManagedConfig,
    metadata: Discovery,
}
static BROWSER_FLOW: Mutex<Option<BrowserFlow>> = Mutex::new(None);
static BROWSER_RESULT: Mutex<Option<(String, Result<(), String>)>> = Mutex::new(None);
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAuthorization {
    pub flow_id: String,
    pub authorization_url: String,
}

pub fn cancel_sign_in() -> Result<(), String> {
    clear_sign_in(false)
}
fn clear_sign_in(allow_completed: bool) -> Result<(), String> {
    // Replacement and sign-out invalidate work before waiting for credentials.
    if allow_completed {
        SIGN_IN_GENERATION.fetch_add(1, Ordering::SeqCst);
    }
    // Serialize cancellation with credential acceptance. Never report success
    // after the callback committed an account that callers may already use.
    let _credential = REFRESH_LOCK.lock().map_err(|_| "credential lock")?;
    let mut pending = BROWSER_FLOW.lock().map_err(|_| "sign-in lock")?;
    if !allow_completed
        && pending
            .as_ref()
            .is_some_and(|flow| flow.credentials_accepted)
    {
        return Err("Sign-in already completed. Use Sign out to leave this account.".into());
    }
    if !allow_completed {
        SIGN_IN_GENERATION.fetch_add(1, Ordering::SeqCst);
    }
    *pending = None;
    *BROWSER_RESULT.lock().map_err(|_| "sign-in lock")? = None;
    Ok(())
}
pub fn begin_browser_sign_in(create_account: bool) -> Result<BrowserAuthorization, String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use sha2::{Digest, Sha256};
    clear_sign_in(true)?;
    let generation = SIGN_IN_GENERATION.load(Ordering::SeqCst);
    let config = config()?;
    let metadata = discovery(&config)?;
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let state = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let id = uuid::Uuid::new_v4().to_string();
    let mut url = reqwest::Url::parse(&metadata.authorization_endpoint)
        .map_err(|_| "invalid authorization endpoint")?;
    url.query_pairs_mut().extend_pairs([
        ("client_id", config.client_id.as_str()),
        ("redirect_uri", CALLBACK),
        ("response_type", "code"),
        ("scope", "openid email profile offline_access"),
        ("resource", config.audience.as_str()),
        ("state", state.as_str()),
        ("code_challenge_method", "S256"),
        (
            "code_challenge",
            URL_SAFE_NO_PAD
                .encode(Sha256::digest(verifier.as_bytes()))
                .as_str(),
        ),
    ]);
    if create_account {
        url.query_pairs_mut().append_pair("prompt", "create");
    }
    let mut pending = BROWSER_FLOW.lock().map_err(|_| "sign-in lock")?;
    if SIGN_IN_GENERATION.load(Ordering::SeqCst) != generation {
        return Err("sign-in cancelled".into());
    }
    *pending = Some(BrowserFlow {
        processing: false,
        credentials_accepted: false,
        id: id.clone(),
        state,
        verifier,
        expires: Instant::now() + Duration::from_secs(600),
        generation,
        config,
        metadata,
    });
    Ok(BrowserAuthorization {
        flow_id: id,
        authorization_url: url.into(),
    })
}
fn callback_parameters(raw: &str, flow: &BrowserFlow) -> Result<HashMap<String, String>, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "invalid sign-in callback")?;
    if url.scheme() != "com.alamaslabs.savvy"
        || url.has_host()
        || url.path() != "/oauth/callback"
        || url.fragment().is_some()
    {
        return Err("invalid sign-in callback".into());
    }
    let mut params = HashMap::new();
    for (key, value) in url.query_pairs() {
        if params
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err("duplicate callback parameter".into());
        }
    }
    if params.get("state") != Some(&flow.state)
        || params.get("iss") != Some(&flow.metadata.issuer)
        || Instant::now() >= flow.expires
        || SIGN_IN_GENERATION.load(Ordering::SeqCst) != flow.generation
    {
        return Err("expired or unsolicited sign-in callback".into());
    }
    Ok(params)
}
pub fn finish_browser_callback(raw: &str, meeting_active: bool) -> Result<(), String> {
    let (flow, params) = {
        let mut pending = BROWSER_FLOW.lock().map_err(|_| "sign-in lock")?;
        let flow = pending.as_mut().ok_or("no pending sign-in")?;
        if flow.processing {
            return Err("sign-in callback already consumed".into());
        }
        let params = callback_parameters(raw, flow)?;
        flow.processing = true;
        (flow.clone(), params)
    };
    let result = (|| {
        if params.contains_key("error") {
            return Err("Sign-in was declined. Try again.".into());
        }
        let code = params
            .get("code")
            .filter(|code| !code.is_empty())
            .ok_or("missing authorization code")?;
        let token: TokenResponse = bounded_json(
            http()?
                .post(&flow.metadata.token_endpoint)
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("client_id", flow.config.client_id.as_str()),
                    ("redirect_uri", CALLBACK),
                    ("code", code.as_str()),
                    ("code_verifier", flow.verifier.as_str()),
                ])
                .send()
                .map_err(|_| "sign-in exchange unavailable")?
                .error_for_status()
                .map_err(|_| "sign-in code rejected")?,
            MAX_AUTH_RESPONSE_BYTES,
        )
        .map_err(|_| "invalid sign-in response")?;
        let refresh = token.refresh_token.ok_or("missing offline credential")?;
        // The service verifies signature, issuer, subject, audience and expiry before this app accepts the account.
        let verified: serde_json::Value = bounded_json(
            http()?
                .get(format!(
                    "{}/v1/account",
                    flow.config.service_url.trim_end_matches('/')
                ))
                .bearer_auth(&token.access_token)
                .send()
                .map_err(|_| "account service unavailable")?
                .error_for_status()
                .map_err(|_| "account verification failed")?,
            MAX_AUTH_RESPONSE_BYTES,
        )
        .map_err(|_| "invalid verified account")?;
        let identity = (
            verified["identity"]["issuer"]
                .as_str()
                .ok_or("missing verified issuer")?
                .to_owned(),
            verified["identity"]["subject"]
                .as_str()
                .ok_or("missing verified subject")?
                .to_owned(),
        );
        if identity.0 != flow.metadata.issuer {
            revoke_refresh(flow.config.clone(), refresh)?;
            return Err("account issuer mismatch".into());
        }
        let _guard = REFRESH_LOCK.lock().map_err(|_| "credential lock")?;
        if SIGN_IN_GENERATION.load(Ordering::SeqCst) != flow.generation
            || Instant::now() >= flow.expires
        {
            revoke_refresh(flow.config.clone(), refresh)?;
            return Err("sign-in cancelled or expired".into());
        }
        let mut pending = BROWSER_FLOW.lock().map_err(|_| "sign-in lock")?;
        let current = pending
            .as_mut()
            .filter(|current| current.id == flow.id)
            .ok_or("sign-in cancelled or replaced")?;
        let mut previous = ACCOUNT_IDENTITY.lock().map_err(|_| "identity lock")?;
        let changed_identity = previous.as_ref() != Some(&identity);
        if changed_identity {
            if meeting_active
                || SERVICE_OPERATIONS.load(Ordering::SeqCst) > 0
                || !BRIEF_RETRY
                    .lock()
                    .map_err(|_| "brief retry lock")?
                    .is_empty()
                || !COMPLETED_BRIEFS
                    .lock()
                    .map_err(|_| "brief recovery lock")?
                    .is_empty()
                || !PREPARED.lock().map_err(|_| "session lock")?.is_empty()
                || !SESSION_VIEWS.lock().map_err(|_| "session lock")?.is_empty()
                || !ACTIVE_REQUESTS
                    .lock()
                    .map_err(|_| "request lock")?
                    .is_empty()
            {
                revoke_refresh(flow.config.clone(), refresh)?;
                return Err(
                    "End the meeting and pending requests before changing accounts.".into(),
                );
            }
            AUTH_GENERATION.fetch_add(1, Ordering::SeqCst);
            clear_account_state();
        }
        let old = stored_refresh_token()?;
        if let Some(old) = old {
            if old != refresh {
                queue_revocation(flow.config.clone(), old)?;
            }
        }
        store_refresh_token(&refresh)?;
        *previous = Some(identity);
        cache_access_token(token.access_token, token.expires_in)?;
        current.credentials_accepted = true;
        retry_revocations();
        Ok(())
    })();
    let mut completed = BROWSER_RESULT.lock().map_err(|_| "sign-in lock")?;
    if SIGN_IN_GENERATION.load(Ordering::SeqCst) == flow.generation {
        *completed = Some((flow.id, result.clone()));
    }
    result
}
pub fn wait_browser_sign_in(authorization: &BrowserAuthorization) -> Result<(), String> {
    let generation = SIGN_IN_GENERATION.load(Ordering::SeqCst);
    let deadline = Instant::now() + Duration::from_secs(600);
    if !BROWSER_FLOW
        .lock()
        .map_err(|_| "sign-in lock")?
        .as_ref()
        .is_some_and(|flow| flow.id == authorization.flow_id)
        && !BROWSER_RESULT
            .lock()
            .map_err(|_| "sign-in lock")?
            .as_ref()
            .is_some_and(|(id, _)| id == &authorization.flow_id)
    {
        return Err("no matching sign-in attempt".into());
    }
    loop {
        if SIGN_IN_GENERATION.load(Ordering::SeqCst) != generation || Instant::now() >= deadline {
            return Err("sign-in cancelled or expired".into());
        }
        let mut result = BROWSER_RESULT.lock().map_err(|_| "sign-in lock")?;
        if result
            .as_ref()
            .is_some_and(|(id, _)| id == &authorization.flow_id)
        {
            return result.take().ok_or("sign-in result unavailable")?.1;
        }
        drop(result);
        std::thread::sleep(Duration::from_millis(100));
    }
}

// --- OIDC device-authorization flow -----------------------------------------

#[cfg(test)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthorization {
    pub flow_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub interval_seconds: u64,
    pub expires_in_seconds: u64,
}

#[cfg(test)]
#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    #[serde(default = "default_interval")]
    interval: u64,
    expires_in: u64,
}

#[cfg(test)]
fn default_interval() -> u64 {
    5
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    #[serde(default = "default_expiry", deserialize_with = "token_expiry")]
    expires_in: u64,
}

fn default_expiry() -> u64 {
    600
}

fn token_expiry<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let seconds = u64::deserialize(deserializer)?;
    // Savvy accepts access-token lifetimes of at most one day.
    if !(1..=86_400).contains(&seconds) {
        return Err(serde::de::Error::custom("invalid access-token lifetime"));
    }
    Ok(seconds)
}

#[cfg(test)]
pub fn start_device_authorization() -> Result<DeviceAuthorization, String> {
    let config = config()?;
    let response: DeviceCodeResponse = bounded_json(
        http()?
            .post(format!(
                "{}/oauth/device/code",
                config.issuer_url.trim_end_matches('/')
            ))
            .form(&[
                ("client_id", config.client_id.as_str()),
                ("scope", "openid offline_access"),
                ("audience", config.audience.as_str()),
            ])
            .send()
            .map_err(|error| format!("could not reach the sign-in service: {error}"))?
            .error_for_status()
            .map_err(|error| format!("sign-in could not start: {error}"))?,
        MAX_AUTH_RESPONSE_BYTES,
    )
    .map_err(|error| format!("sign-in returned an unexpected response: {error}"))?;
    require_trusted_url(&response.verification_uri)?;
    if let Some(url) = &response.verification_uri_complete {
        require_trusted_url(url)?;
    }
    let flow_id = uuid::Uuid::new_v4().to_string();
    let generation = AUTH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let mut flows = DEVICE_FLOWS.lock().map_err(|_| "device flow lock")?;
    flows.clear();
    let interval = response.interval.clamp(1, 60);
    let expires = response.expires_in.min(900);
    flows.insert(
        flow_id.clone(),
        DeviceFlow {
            code: response.device_code,
            expires: Instant::now() + Duration::from_secs(expires),
            interval,
            generation,
        },
    );
    Ok(DeviceAuthorization {
        flow_id,
        user_code: response.user_code,
        verification_uri: response.verification_uri,
        verification_uri_complete: response.verification_uri_complete,
        interval_seconds: response.interval,
        expires_in_seconds: response.expires_in,
    })
}

/// Polls the issuer until the user approves, denies, or the code expires.
/// Honors `authorization_pending` and `slow_down` per RFC 8628. On success the
/// refresh token goes to the Keychain and the access token stays in memory.
#[cfg(test)]
pub fn poll_device_authorization(authorization: &DeviceAuthorization) -> Result<(), String> {
    let config = config()?;
    let client = http()?;
    let flow = DEVICE_FLOWS
        .lock()
        .map_err(|_| "device flow lock")?
        .remove(&authorization.flow_id)
        .ok_or("sign_in_required: expired sign-in flow")?;
    let deadline = flow.expires;
    let mut interval = Duration::from_secs(flow.interval);
    loop {
        if AUTH_GENERATION.load(Ordering::SeqCst) != flow.generation || Instant::now() >= deadline {
            return Err(typed_error(
                SIGN_IN_REQUIRED,
                "the sign-in code expired; start sign-in again",
            ));
        }
        let next = Instant::now() + interval;
        while Instant::now() < next {
            if AUTH_GENERATION.load(Ordering::SeqCst) != flow.generation
                || Instant::now() >= deadline
            {
                return Err(sign_in_required_error());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let response = client
            .post(format!(
                "{}/oauth/token",
                config.issuer_url.trim_end_matches('/')
            ))
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", flow.code.as_str()),
                ("client_id", config.client_id.as_str()),
            ])
            .send()
            .map_err(|error| format!("could not reach the sign-in service: {error}"))?;
        if response.status().is_success() {
            let token: TokenResponse = bounded_json(response, MAX_AUTH_RESPONSE_BYTES)
                .map_err(|error| format!("sign-in returned an unexpected response: {error}"))?;
            let refresh = token.refresh_token.ok_or_else(|| {
                "sign-in completed without an offline credential; check the client configuration"
                    .to_owned()
            })?;
            let _guard = REFRESH_LOCK.lock().map_err(|_| "credential lock")?;
            if AUTH_GENERATION.load(Ordering::SeqCst) != flow.generation {
                return Err(sign_in_required_error());
            }
            store_refresh_token(&refresh)?;
            cache_access_token(token.access_token, token.expires_in)?;
            return Ok(());
        }
        let error: serde_json::Value = bounded_json(response, MAX_AUTH_RESPONSE_BYTES)?;
        match error["error"].as_str().unwrap_or("") {
            "authorization_pending" => {}
            "slow_down" => interval += Duration::from_secs(5),
            "expired_token" => {
                return Err(typed_error(
                    SIGN_IN_REQUIRED,
                    "the sign-in code expired; start sign-in again",
                ))
            }
            "access_denied" => return Err(typed_error(SIGN_IN_REQUIRED, "sign-in was declined")),
            other => {
                return Err(format!(
                    "sign-in failed: {}",
                    if other.is_empty() {
                        "unexpected issuer response"
                    } else {
                        other
                    }
                ))
            }
        }
    }
}

pub fn sign_out() -> Result<(), String> {
    let _brief_guard = BRIEF_GENERATION
        .try_lock()
        .map_err(|_| "Finish the pending brief before signing out.")?;
    if !COMPLETED_BRIEFS
        .lock()
        .map_err(|_| "brief recovery lock")?
        .is_empty()
        || !BRIEF_RETRY
            .lock()
            .map_err(|_| "brief retry lock")?
            .is_empty()
    {
        return Err("Finish saving or retrying the pending brief before signing out.".into());
    }
    require_audio_check_finished()?;
    AUTH_GENERATION.fetch_add(1, Ordering::SeqCst);
    clear_sign_in(true)?;
    #[cfg(test)]
    if let Ok(mut flows) = DEVICE_FLOWS.lock() {
        flows.clear();
    }
    let _refresh_guard = REFRESH_LOCK
        .lock()
        .map_err(|_| "credential lock unavailable")?;
    // A check may have registered after the initial cancellation preflight.
    require_audio_check_finished()?;
    let bearer = ACCESS_TOKEN
        .lock()
        .ok()
        .and_then(|cached| cached.as_ref().map(|cached| cached.access_token.clone()));
    let keys = active_request_keys();
    let revoked = read_refresh_token()?;
    if let Some(token) = revoked {
        queue_revocation(config()?, token)?;
    }
    delete_refresh_token()?;
    clear_account_state();
    if let Ok(mut identity) = ACCOUNT_IDENTITY.lock() {
        *identity = None;
    }
    if let Ok(mut cached) = ACCESS_TOKEN.lock() {
        *cached = None;
    }
    drop(_refresh_guard);
    if !keys.is_empty() {
        let configuration = config();
        std::thread::spawn(move || {
            if let (Some(token), Ok(config), Ok(client)) = (bearer, configuration, http()) {
                for key in keys {
                    let _ = client
                        .post(format!(
                            "{}/v1/requests/{key}/cancel",
                            config.service_url.trim_end_matches('/')
                        ))
                        .bearer_auth(&token)
                        .json(&serde_json::json!({}))
                        .timeout(Duration::from_secs(5))
                        .send();
                }
            }
        });
    }
    retry_revocations();
    Ok(())
}

fn cache_access_token(access_token: String, expires_in_seconds: u64) -> Result<(), String> {
    // Expire 30 s early (half the lifetime for tokens under 60 s) to avoid expiry races.
    let expires_at = Instant::now()
        .checked_add(Duration::from_secs(
            expires_in_seconds.saturating_sub(expires_in_seconds.min(60) / 2),
        ))
        .ok_or("invalid access-token lifetime")?;
    let mut cached = ACCESS_TOKEN.lock().map_err(|_| "access-token lock")?;
    *cached = Some(CachedToken {
        access_token,
        expires_at,
    });
    Ok(())
}

fn access_token() -> Result<String, String> {
    let _refresh_guard = REFRESH_LOCK
        .lock()
        .map_err(|_| "credential lock unavailable")?;
    if let Ok(cached) = ACCESS_TOKEN.lock() {
        if let Some(token) = cached.as_ref() {
            if Instant::now() < token.expires_at {
                return Ok(token.access_token.clone());
            }
        }
    }
    let generation = AUTH_GENERATION.load(Ordering::SeqCst);
    let refresh = stored_refresh_token()?.ok_or_else(sign_in_required_error)?;
    let config = config()?;
    let response = http()?
        .post(discovery(&config)?.token_endpoint)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.as_str()),
            ("client_id", config.client_id.as_str()),
        ])
        .send()
        .map_err(|error| format!("could not reach the sign-in service: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body: serde_json::Value =
            bounded_json(response, MAX_AUTH_RESPONSE_BYTES).unwrap_or_default();
        if status.as_u16() == 400 && body["error"] == "invalid_grant" {
            delete_refresh_token()?;
            return Err(sign_in_required_error());
        }
        return Err(typed_error(
            "provider_unavailable",
            "sign-in service temporarily unavailable",
        ));
    }
    let token: TokenResponse = bounded_json(response, MAX_AUTH_RESPONSE_BYTES)
        .map_err(|error| format!("sign-in returned an unexpected response: {error}"))?;
    if AUTH_GENERATION.load(Ordering::SeqCst) != generation {
        if let Some(rotated) = token.refresh_token {
            revoke_refresh(config.clone(), rotated)?;
        }
        return Err(sign_in_required_error());
    }
    if let Some(rotated) = token.refresh_token.as_deref() {
        store_refresh_token(rotated)?;
    }
    cache_access_token(token.access_token.clone(), token.expires_in)?;
    Ok(token.access_token)
}

// --- service requests --------------------------------------------------------

/// Sends one authenticated JSON request to the managed service and maps typed
/// service errors to the `code: message` string shape.
fn service_post(path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    let serialized = serde_json::to_vec(body).map_err(|error| error.to_string())?;
    if serialized.len() > savvy_providers::MAX_MANAGED_REQUEST_BYTES {
        return Err(typed_error("context_too_large", "Shorten the brief or reduce selected context before starting. Required context was not removed."));
    }
    let _operation = ServiceOperation::begin()?;
    let generation = AUTH_GENERATION.load(Ordering::SeqCst);
    let config = config()?;
    let token = access_token()?;
    let response = http()?
        .post(format!(
            "{}{path}",
            config.service_url.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .timeout(Duration::from_secs(if path == "/v1/briefs" {
            125
        } else if path.ends_with("/recommendations") {
            35
        } else {
            15
        }))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serialized)
        .send()
        .map_err(|error| format!("could not reach the Savvy service: {error}"))?;
    if generation != AUTH_GENERATION.load(Ordering::SeqCst) {
        return Err(sign_in_required_error());
    }
    read_service_response(response)
}

pub fn service_get(path: &str) -> Result<serde_json::Value, String> {
    let _operation = ServiceOperation::begin()?;
    let config = config()?;
    let token = access_token()?;
    let response = http()?
        .get(format!(
            "{}{path}",
            config.service_url.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .timeout(Duration::from_secs(15))
        .send()
        .map_err(|error| format!("could not reach the Savvy service: {error}"))?;
    read_service_response(response)
}

pub fn source_connections() -> Result<serde_json::Value, String> {
    service_get("/v1/sources/connections")
}

pub fn source_connect(provider: &str) -> Result<String, String> {
    let response = service_post(
        "/v1/sources/connect",
        &serde_json::json!({"provider": provider}),
    )?;
    let url = response["url"]
        .as_str()
        .ok_or("connection link is missing")?;
    if !url.starts_with("https://") {
        return Err("connection link is invalid".into());
    }
    Ok(url.to_owned())
}

pub fn source_disconnect(provider: &str) -> Result<(), String> {
    service_post(
        "/v1/sources/disconnect",
        &serde_json::json!({"provider": provider}),
    )?;
    Ok(())
}

pub fn source_search(body: &serde_json::Value) -> Result<serde_json::Value, String> {
    service_post("/v1/sources/search", body)
}

pub fn source_fetch(body: &serde_json::Value) -> Result<serde_json::Value, String> {
    service_post("/v1/sources/fetch", body)
}

fn read_service_response(
    response: reqwest::blocking::Response,
) -> Result<serde_json::Value, String> {
    let status = response.status();
    if status == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
        return Err(typed_error("context_too_large", "Selected context exceeds the request limit. Deselect documents or shorten instructions."));
    }
    let limit = if status.is_success() {
        MAX_SERVICE_RESPONSE_BYTES
    } else {
        MAX_AUTH_RESPONSE_BYTES
    };
    let body: serde_json::Value = bounded_json(response, limit)
        .map_err(|error| typed_error("provider_unavailable", &error))?;
    if status.is_success() {
        return Ok(body);
    }
    let code = body["code"].as_str().unwrap_or("provider_unavailable");
    let message = body["message"]
        .as_str()
        .unwrap_or("the Savvy service returned an error");
    Err(typed_error(code, message))
}

static BRIEF_GENERATION: Mutex<()> = Mutex::new(());
static BRIEF_RETRY: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static COMPLETED_BRIEFS: LazyLock<Mutex<HashMap<String, savvy_providers::GeneratedBrief>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub fn acknowledge_brief(request: &savvy_providers::BriefWireRequest) {
    if let Ok(binding) = funding_binding() {
        if let Ok(digest) = brief_digest(request, &binding) {
            if let Ok(mut completed) = COMPLETED_BRIEFS.lock() {
                completed.remove(&digest);
            }
        }
    }
}
#[cfg(test)]
pub fn generate_brief(
    request: &savvy_providers::BriefWireRequest,
) -> Result<savvy_providers::GeneratedBrief, String> {
    generate_brief_for_job(request, None)
}

/// Generates a brief through the hosted service. The response is mapped back
/// through the same `map_generated_brief` validation as BYOK output.
pub fn generate_brief_for_job(
    request: &savvy_providers::BriefWireRequest,
    job: Option<&crate::BriefJob>,
) -> Result<savvy_providers::GeneratedBrief, String> {
    if let Some(job) = job {
        job.check()?;
    }
    let _brief_guard = BRIEF_GENERATION
        .try_lock()
        .map_err(|_| "Wait for the pending brief before generating another.")?;
    let _operation = ServiceOperation::begin()?;
    ensure_signed_in()?;
    let generation = AUTH_GENERATION.load(Ordering::SeqCst);
    let expected = job.map(|job| job.funding()).transpose()?.flatten();
    let funding = funding_selection(expected.as_ref())?;
    let binding = funding_binding()?;
    let digest = brief_digest(request, &binding)?;
    {
        let completed = COMPLETED_BRIEFS.lock().map_err(|_| "brief recovery lock")?;
        if let Some(brief) = completed.get(&digest) {
            return Ok(brief.clone());
        }
        if completed.len() >= 16 {
            return Err("Finish saving previous briefs before generating another.".into());
        }
    }
    // A paid result remains the person's recoverable artifact after seat removal.
    funding_snapshot(Some(&funding))?;
    let (key, was_pending) = {
        let mut retry = BRIEF_RETRY.lock().map_err(|_| "brief retry lock")?;
        if !retry.contains_key(&digest) && retry.len() >= 16 {
            return Err("Retry pending briefs before generating another.".into());
        }
        let was_pending = retry.contains_key(&digest);
        let key = retry
            .entry(digest.clone())
            .or_insert_with(|| uuid::Uuid::new_v4().to_string())
            .clone();
        (key, was_pending)
    };
    let body = serde_json::json!({
        "idempotencyKey": key,
        "request": request,
        "funding": funding,
    });
    if serde_json::to_vec(&body)
        .map_err(|_| "invalid brief request")?
        .len()
        > savvy_providers::MAX_MANAGED_REQUEST_BYTES
    {
        BRIEF_RETRY
            .lock()
            .map_err(|_| "brief retry lock")?
            .remove(&digest);
        return Err(typed_error("context_too_large", "Selected context exceeds the request limit. Deselect documents or shorten instructions."));
    }
    if let Some(job) = job {
        if let Err(error) = job.bind_managed_key(&key) {
            if !was_pending {
                BRIEF_RETRY
                    .lock()
                    .map_err(|_| "brief retry lock")?
                    .remove(&digest);
            }
            return Err(error);
        }
    }
    ACTIVE_REQUESTS
        .lock()
        .map_err(|_| "request lock")?
        .push(key.clone());
    let outcome = match service_post("/v1/briefs", &body) {
        Err(error) if error.starts_with("could not reach the Savvy service") => {
            service_post("/v1/briefs", &body)
        }
        result => result,
    };
    if let Ok(mut active) = ACTIVE_REQUESTS.lock() {
        active.retain(|request| request != &key);
    }
    let _credential_guard = REFRESH_LOCK.lock().map_err(|_| "credential lock")?;
    if generation != AUTH_GENERATION.load(Ordering::SeqCst) {
        return Err(sign_in_required_error());
    }
    let response = match outcome {
        Ok(response) => response,
        Err(error) => {
            // Ambiguous delivery and an in-flight server request retain the same key.
            if [
                "invalid_request:",
                "context_too_large:",
                "quota_exhausted:",
                "result_unavailable:",
                "no_seat:",
                "funding_mismatch:",
                "funding_unavailable:",
            ]
            .iter()
            .any(|code| error.starts_with(code))
            {
                BRIEF_RETRY
                    .lock()
                    .map_err(|_| "brief retry lock")?
                    .remove(&digest);
            }
            return Err(error);
        }
    };
    let brief: savvy_providers::GeneratedBrief = serde_json::from_value(response["brief"].clone())
        .map_err(|error| format!("the Savvy service returned an invalid brief: {error}"))?;
    BRIEF_RETRY
        .lock()
        .map_err(|_| "brief retry lock")?
        .remove(&digest);
    COMPLETED_BRIEFS
        .lock()
        .map_err(|_| "brief recovery lock")?
        .insert(digest, brief.clone());
    Ok(brief)
}

pub fn account_summary() -> Result<serde_json::Value, String> {
    let _operation = ServiceOperation::begin()?;
    ensure_signed_in()?;
    let generation = AUTH_GENERATION.load(Ordering::SeqCst);
    let mut summary = service_get("/v1/account")?;
    let _guard = REFRESH_LOCK.lock().map_err(|_| "credential lock")?;
    if generation != AUTH_GENERATION.load(Ordering::SeqCst) {
        return Err(sign_in_required_error());
    }
    if let (Some(issuer), Some(subject)) = (
        summary["identity"]["issuer"].as_str(),
        summary["identity"]["subject"].as_str(),
    ) {
        if issuer != config()?.issuer_url {
            return Err("verified account issuer mismatch".into());
        }
        *ACCOUNT_IDENTITY.lock().map_err(|_| "identity lock")? =
            Some((issuer.into(), subject.into()));
    }
    match selected_funding() {
        Ok(choice) => {
            summary["funding"] =
                serde_json::to_value(choice).map_err(|_| "Invalid funding choice.")?
        }
        Err(error) => {
            summary["funding"] = serde_json::json!({"kind":"unavailable"});
            summary["fundingError"] = error.into();
        }
    }
    summary["fundingLocked"] = serde_json::json!(
        SERVICE_OPERATIONS.load(Ordering::SeqCst) > 1
            || !SESSION_FUNDING
                .lock()
                .map_err(|_| "funding lock")?
                .is_empty()
            || !BRIEF_RETRY
                .lock()
                .map_err(|_| "brief retry lock")?
                .is_empty()
            || !COMPLETED_BRIEFS
                .lock()
                .map_err(|_| "brief recovery lock")?
                .is_empty()
    );
    Ok(summary)
}

// --- hosted meeting sessions -------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub session_id: String,
    pub state: String,
    pub lease_version: u64,
    pub settled_ms: i64,
    pub meeting_ms_available: i64,
    pub warning: Option<String>,
    #[serde(default)]
    pub funding: Option<FundingChoice>,
}

/// Creates or reattaches the hosted session for a local meeting. Idempotent,
/// so a reconnecting client resumes the same billable session rather than
/// opening a second one.
pub fn create_session(session_id: &str) -> Result<SessionView, String> {
    create_session_with_funding(session_id, None)
}
fn create_session_with_funding(
    session_id: &str,
    expected: Option<&FundingChoice>,
) -> Result<SessionView, String> {
    let _operation = ServiceOperation::begin()?;
    ensure_signed_in()?;
    let existing = SESSION_FUNDING
        .lock()
        .map_err(|_| "funding lock")?
        .get(session_id)
        .cloned();
    let binding = if let Some(binding) = existing {
        if binding.generation != AUTH_GENERATION.load(Ordering::SeqCst)
            || expected.is_some_and(|choice| *choice != binding.choice)
        {
            return Err(typed_error(
                "funding_mismatch",
                "This meeting is bound to a different payer.",
            ));
        }
        binding
    } else {
        funding_snapshot(expected)?;
        funding_binding()?
    };
    let response = service_post(
        "/v1/sessions",
        &serde_json::json!({"sessionId":session_id,"funding":binding.choice}),
    )?;
    let view: SessionView = serde_json::from_value(response)
        .map_err(|error| format!("the Savvy service returned an invalid session: {error}"))?;
    if view
        .funding
        .as_ref()
        .is_some_and(|choice| *choice != binding.choice)
        || (matches!(binding.choice, FundingChoice::Organization { .. }) && view.funding.is_none())
    {
        let _ = service_post(
            &format!("/v1/sessions/{session_id}/stop"),
            &serde_json::json!({"leaseVersion":view.lease_version,"commandId":next_command()}),
        );
        return Err(typed_error(
            "funding_mismatch",
            "The service did not confirm the selected payer. No audio was started.",
        ));
    }
    let _guard = REFRESH_LOCK.lock().map_err(|_| "credential lock")?;
    if binding.generation != AUTH_GENERATION.load(Ordering::SeqCst) {
        return Err(sign_in_required_error());
    }
    SESSION_FUNDING
        .lock()
        .map_err(|_| "funding lock")?
        .insert(session_id.to_owned(), binding);
    Ok(view)
}

fn session_action(session_id: &str, action: &str) -> Result<SessionView, String> {
    let command = next_command();
    session_action_ordered(session_id, action, command)
}
static LIFECYCLE_COMMAND: AtomicU64 = AtomicU64::new(0);
pub fn next_command() -> u64 {
    LIFECYCLE_COMMAND.fetch_add(1, Ordering::SeqCst) + 1
}
pub fn session_action_ordered(
    session_id: &str,
    action: &str,
    command: u64,
) -> Result<SessionView, String> {
    let version = create_session(session_id)?.lease_version;
    let response = service_post(
        &format!("/v1/sessions/{session_id}/{action}"),
        &serde_json::json!({"leaseVersion":version,"commandId":command}),
    )?;
    serde_json::from_value(response)
        .map_err(|error| format!("the Savvy service returned an invalid session: {error}"))
}

pub fn resume_session(session_id: &str) -> Result<SessionView, String> {
    session_action(session_id, "resume")
}

/// Blocks on two service round-trips (reattach, then stop); callers on the UI
/// path must spawn it. A failed stop is settled by the service's lease expiry.
pub fn stop_session(session_id: &str) -> Result<SessionView, String> {
    discard_prepared(session_id);
    if let Ok(mut views) = SESSION_VIEWS.lock() {
        views.retain(|view| view.session_id != session_id);
    }
    let result = session_action(session_id, "stop");
    if let Ok(mut bindings) = SESSION_FUNDING.lock() {
        bindings.remove(session_id);
    }
    result
}

/// The access token for the relay WebSocket. Kept separate from the HTTP
/// helpers because the transcription crate opens its own connection.
pub fn relay_credentials() -> Result<(String, String), String> {
    Ok((config()?.service_url, access_token()?))
}

static SESSION_VIEWS: Mutex<Vec<SessionView>> = Mutex::new(Vec::new());
static PREPARED: Mutex<Vec<(String, SessionView, String, String)>> = Mutex::new(Vec::new());
static ACTIVE_REQUESTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn prepare_session(id: &str) -> Result<(), String> {
    prepare_session_with_funding(id, None)
}
pub fn prepare_session_with_funding(
    id: &str,
    expected: Option<&FundingChoice>,
) -> Result<(), String> {
    let _operation = ServiceOperation::begin()?;
    let generation = AUTH_GENERATION.load(Ordering::SeqCst);
    let session = create_session_with_funding(id, expected)?;
    let (url, token) = match relay_credentials() {
        Ok(value) => value,
        Err(error) => {
            let _ = stop_session(id);
            return Err(error);
        }
    };
    let _guard = REFRESH_LOCK.lock().map_err(|_| "credential lock")?;
    if generation != AUTH_GENERATION.load(Ordering::SeqCst) {
        return Err(sign_in_required_error());
    }
    PREPARED
        .lock()
        .map_err(|_| "session lock")?
        .push((id.to_owned(), session, url, token));
    Ok(())
}
pub fn discard_prepared(id: &str) {
    if let Ok(mut prepared) = PREPARED.lock() {
        prepared.retain(|(key, _, _, _)| key != id);
    }
}
pub fn take_prepared(id: &str) -> Result<(SessionView, String, String), String> {
    let _guard = REFRESH_LOCK.lock().map_err(|_| "credential lock")?;
    let binding = SESSION_FUNDING
        .lock()
        .map_err(|_| "funding lock")?
        .get(id)
        .cloned()
        .ok_or("managed payer is not ready")?;
    if binding != funding_binding()? {
        return Err(typed_error(
            "funding_mismatch",
            "Funding changed after meeting context approval.",
        ));
    }
    let mut prepared = PREPARED.lock().map_err(|_| "session lock")?;
    let index = prepared
        .iter()
        .position(|(key, _, _, _)| key == id)
        .ok_or("managed session authorization is not ready")?;
    let (_, session, url, token) = prepared.remove(index);
    let mut views = SESSION_VIEWS.lock().map_err(|_| "session lock")?;
    views.retain(|v| v.session_id != id);
    views.push(session.clone());
    Ok((session, url, token))
}

pub fn meeting_context_request(
    session_id: uuid::Uuid,
    brief: &savvy_domain::NegotiationBrief,
    context: &savvy_domain::ContextPack,
) -> Result<savvy_providers::AdviceWireRequest, String> {
    // Check six excerpts with the largest serialized byte sizes; live requests
    // still undergo the supplier token check because token density varies.
    let mut evidence = context
        .guideline_sources
        .iter()
        .chain(&context.client_sources)
        .map(|source| {
            let wire = savvy_providers::WireEvidence::from(source);
            serde_json::to_vec(&wire)
                .map(|bytes| (bytes.len(), wire))
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    evidence.sort_by_key(|(size, _)| std::cmp::Reverse(*size));
    let request = savvy_providers::AdviceWireRequest {
        session_id,
        generation_id: 0,
        transcript_revision: 0,
        trigger: savvy_domain::Trigger::Opportunity,
        language: brief.response_language.clone(),
        brief_markdown: brief.document_content.clone(),
        hard_constraints: context.hard_constraints.clone(),
        evidence: evidence.into_iter().take(6).map(|(_, wire)| wire).collect(),
        meeting_ledger: Default::default(),
        recent_turns: Vec::new(),
        focal_turn_ids: Vec::new(),
    };
    if serde_json::to_vec(&serde_json::json!({"request": &request}))
        .map_err(|error| error.to_string())?
        .len()
        > 786_432
    {
        return Err(typed_error("context_too_large", "Shorten the brief or reduce selected context before starting. Live context needs 256 KiB of request space."));
    }
    Ok(request)
}

pub fn check_meeting_context(request: &savvy_providers::AdviceWireRequest) -> Result<(), String> {
    let response = service_post(
        &format!("/v1/sessions/{}/context", request.session_id),
        &serde_json::json!({"request": request}),
    )?;
    if response["ready"] != true {
        return Err(
            "The service could not verify meeting context. Try again before starting.".into(),
        );
    }
    Ok(())
}

pub fn generate_advice(
    request: &savvy_providers::AdviceWireRequest,
) -> Result<(savvy_providers::ProviderAdvice, Option<String>), String> {
    let key = format!(
        "{}:{}:{}",
        request.session_id, request.generation_id, request.transcript_revision
    );
    let lease = SESSION_VIEWS
        .lock()
        .map_err(|_| "session lock")?
        .iter()
        .find(|v| v.session_id == request.session_id.to_string())
        .map(|v| v.lease_version)
        .ok_or("managed session is unavailable")?;
    ACTIVE_REQUESTS
        .lock()
        .map_err(|_| "request lock")?
        .push(key.clone());
    let result = service_post(
        &format!("/v1/sessions/{}/recommendations", request.session_id),
        &serde_json::json!({"idempotencyKey":key,"leaseVersion":lease,"request":request}),
    );
    if let Ok(mut requests) = ACTIVE_REQUESTS.lock() {
        requests.retain(|id| id != &key);
    }
    let body = result?;
    if body["generationId"] != request.generation_id
        || body["transcriptRevision"] != request.transcript_revision
        || body["sessionId"] != request.session_id.to_string()
    {
        return Err("result_unavailable: stale advice".into());
    }
    let advice = serde_json::from_value(body["advice"].clone())
        .map_err(|_| "invalid managed advice".to_owned())?;
    Ok((advice, body["model"].as_str().map(str::to_owned)))
}
pub fn active_request_keys() -> Vec<String> {
    ACTIVE_REQUESTS
        .lock()
        .map(|keys| keys.clone())
        .unwrap_or_default()
}
pub fn cancel_brief_request(key: &str) -> Result<(), String> {
    service_post(
        &format!("/v1/requests/{key}/cancel"),
        &serde_json::json!({}),
    )
    .map(|_| ())
}

pub fn cancel_request_keys(keys: Vec<String>) {
    for key in keys {
        let _ = service_post(
            &format!("/v1/requests/{key}/cancel"),
            &serde_json::json!({}),
        );
    }
}

pub fn billing_url(product: &str, key: &str) -> Result<String, String> {
    let response = if product == "portal" {
        service_post("/v1/billing/portal", &serde_json::json!({}))?
    } else {
        service_post(
            "/v1/billing/checkout",
            &serde_json::json!({"product":product,"idempotencyKey":key}),
        )?
    };
    let raw = response["url"].as_str().ok_or_else(|| {
        typed_error(
            "payment_pending",
            "Payment is still pending. Refresh your account shortly.",
        )
    })?;
    let url = reqwest::Url::parse(raw).map_err(|_| "invalid billing URL")?;
    let expected = if product == "portal" {
        "billing.stripe.com"
    } else {
        "checkout.stripe.com"
    };
    if url.scheme() != "https"
        || url.host_str() != Some(expected)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("untrusted billing URL".into());
    }
    Ok(raw.to_owned())
}

#[cfg(test)]
mod issuer_tests {
    use super::*;
    use std::{
        io::{Read, Write},
        sync::{atomic::AtomicBool, Arc},
    };
    #[test]
    fn json_responses_are_bounded_before_decoding() {
        fn response(status: u16, headers: &str, body: &[u8]) -> reqwest::blocking::Response {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let wire = [
                format!("HTTP/1.1 {status} Test\r\nConnection: close\r\n{headers}\r\n")
                    .into_bytes(),
                body.to_vec(),
            ]
            .concat();
            std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    assert!(request.len() < 4096);
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                // Early rejection can close the connection while the server writes.
                let _ = stream.write_all(&wire);
            });
            reqwest::blocking::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap()
                .get(format!("http://{address}"))
                .send()
                .unwrap()
        }
        for limit in [MAX_AUTH_RESPONSE_BYTES, MAX_SERVICE_RESPONSE_BYTES] {
            // No body is sent: oversized declared length must fail before reading.
            let declared = response(200, &format!("Content-Length: {}\r\n", limit + 1), b"");
            assert_eq!(
                bounded_json::<serde_json::Value>(declared, limit).unwrap_err(),
                "upstream JSON response exceeds its byte limit"
            );
            for length in [limit, limit + 1] {
                let body = format!("\"{}\"", "a".repeat(length - 2));
                let chunk = format!("{:x}\r\n{body}\r\n0\r\n\r\n", body.len());
                let received = response(200, "Transfer-Encoding: chunked\r\n", chunk.as_bytes());
                let result = bounded_json::<String>(received, limit);
                if length == limit {
                    assert_eq!(result.unwrap().len(), limit - 2);
                } else {
                    assert_eq!(
                        result.unwrap_err(),
                        "upstream JSON response exceeds its byte limit"
                    );
                }
            }
        }
        let malformed = response(200, "Content-Length: 14\r\n", b"private-secret");
        assert_eq!(
            bounded_json::<serde_json::Value>(malformed, MAX_AUTH_RESPONSE_BYTES).unwrap_err(),
            "invalid upstream JSON response"
        );
        // Service errors use the smaller auth limit; successful briefs use 1 MiB.
        let body = format!("\"{}\"", "a".repeat(MAX_AUTH_RESPONSE_BYTES));
        let headers = format!("Content-Length: {}\r\n", body.len());
        assert!(read_service_response(response(200, &headers, body.as_bytes())).is_ok());
        let error = read_service_response(response(500, &headers, body.as_bytes())).unwrap_err();
        assert!(error.contains("provider_unavailable") && error.contains("byte limit"));
        let error = read_service_response(response(413, "Content-Length: 0\r\n", b"")).unwrap_err();
        assert!(error.contains("context_too_large"));
    }

    #[test]
    #[ignore = "requires the explicitly started unified Stripe sandbox and a browser PKCE callback"]
    fn local_stripe_sandbox_desktop_transport() {
        let directory = std::path::PathBuf::from(
            std::env::var("SAVVY_E2E_DIR").expect("private E2E output directory"),
        );
        let state: serde_json::Value =
            serde_json::from_slice(&std::fs::read(directory.join("state.json")).unwrap()).unwrap();
        let service = state["service"].as_str().unwrap().to_owned();
        let issuer = state["issuer"].as_str().unwrap().to_owned();
        assert!(
            service.starts_with("http://127.0.0.1:") && issuer.starts_with("http://127.0.0.1:")
        );
        TEST_CONTEXT.with(|current| {
            *current.borrow_mut() = Some(TestContext {
                config: ManagedConfig {
                    service_url: service,
                    issuer_url: issuer,
                    client_id: state["clientId"].as_str().unwrap().into(),
                    audience: state["audience"].as_str().unwrap().into(),
                },
                credential: Arc::new(Mutex::new(None)),
                revocations: Arc::new(Mutex::new(vec![])),
                revocation_write_failure: Arc::new(AtomicBool::new(false)),
            })
        });
        *ASYNC_TEST_CONTEXT.lock().unwrap() = test_context();
        let app = tauri::test::mock_builder()
            .manage(crate::AppState {
                storage: Mutex::new(
                    crate::Storage::open(&directory.join("desktop.sqlite")).unwrap(),
                ),
                live_meeting: Mutex::new(None),
                settings: Mutex::new(crate::AppSettings::default()),
                app_operation: Mutex::new(false),
                settings_path: directory.join("settings.json"),
                provider_health: Mutex::new(Vec::new()),
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                microphone: Mutex::new(crate::MicrophoneCapture::new()),
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                system_audio: Mutex::new(crate::SystemAudioCapture::new()),
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                transcription_stop: Mutex::new(None),
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                transcription_assembly: Mutex::new(None),
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                codex_server: Mutex::new(None),
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                claude_child: Mutex::new(None),
            })
            .invoke_handler(tauri::generate_handler![
                crate::managed_sign_in_finish,
                crate::managed_sign_in_cancel,
                crate::managed_account,
                crate::managed_sign_out,
                crate::generate_brief_draft,
                crate::cancel_brief_draft,
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let invoke = |command: &str, body: serde_json::Value| {
            tauri::test::get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: if cfg!(target_os = "windows") {
                        "http://tauri.localhost"
                    } else {
                        "tauri://localhost"
                    }
                    .parse()
                    .unwrap(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
        };
        assert_eq!(state["authentication"], "better-auth-pkce");
        assert_eq!(state["service"], state["issuer"]);
        let callback_path = directory.join("callback.txt");
        if callback_path.exists() {
            std::fs::remove_file(&callback_path).unwrap();
        }
        let authorization = begin_browser_sign_in(false).unwrap();
        std::fs::write(
            directory.join("authorization.json"),
            serde_json::to_vec_pretty(&authorization).unwrap(),
        )
        .unwrap();
        // The browser driver uses the real sign-in page and writes the one-use
        // callback. PKCE verifier, token exchange and access tokens stay in Rust.
        let deadline = Instant::now() + Duration::from_secs(600);
        while !callback_path.exists() {
            assert!(Instant::now() < deadline, "browser callback did not arrive");
            std::thread::sleep(Duration::from_millis(100));
        }
        let callback = std::fs::read_to_string(&callback_path).unwrap();
        std::fs::remove_file(&callback_path).unwrap();
        finish_browser_callback(callback.trim(), false).unwrap();
        assert!(finish_browser_callback(callback.trim(), false).is_err());
        let account = invoke(
            "managed_sign_in_finish",
            serde_json::json!({"authorization": authorization}),
        )
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();
        let refresh_before = stored_refresh_token().unwrap();
        let late_cancel = invoke("managed_sign_in_cancel", serde_json::json!({})).unwrap_err();
        assert!(late_cancel.as_str().unwrap().contains("already completed"));
        assert_eq!(stored_refresh_token().unwrap(), refresh_before);
        *ACCESS_TOKEN.lock().unwrap() = None;
        let mut refreshed = invoke("managed_account", serde_json::json!({}))
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap();
        assert!(refreshed["nowMs"].as_u64().unwrap() >= account["nowMs"].as_u64().unwrap());
        refreshed["nowMs"] = account["nowMs"].clone();
        assert_eq!(refreshed, account);
        assert_ne!(stored_refresh_token().unwrap(), refresh_before);
        assert!(invoke(
            "managed_sign_in_finish",
            serde_json::json!({"authorization": null})
        )
        .is_err());
        let cancelled = begin_browser_sign_in(false).unwrap();
        invoke("managed_sign_in_cancel", serde_json::json!({})).unwrap();
        assert!(invoke(
            "managed_sign_in_finish",
            serde_json::json!({"authorization": cancelled})
        )
        .is_err());

        let brief_check = std::env::var("SAVVY_NATIVE_BRIEF_CHECK").as_deref() == Ok("1");
        if brief_check {
            service_post("/v1/dev/grant", &serde_json::json!({"kind":"monthly"})).unwrap();
            let before = account_summary().unwrap()["briefsAvailable"]
                .as_i64()
                .unwrap();
            let guidance = directory.join("guidance");
            std::fs::create_dir(&guidance).unwrap();
            std::fs::write(
                guidance.join("notes.md"),
                "Agree a scope before making commitments.",
            )
            .unwrap();
            {
                use tauri::Manager;
                let state = app.state::<crate::AppState>();
                let mut settings = state.settings.lock().unwrap();
                settings.service_mode = crate::settings::ServiceMode::Managed;
                settings.guidance_folder = Some(guidance.to_string_lossy().into_owned());
            }
            let client: Option<String> = None;
            let cancelled_id = uuid::Uuid::new_v4().to_string();
            let wait_supplier = |id: u32| {
                let deadline = Instant::now() + Duration::from_secs(15);
                while !directory.join(format!("supplier-started-{id}")).exists() {
                    assert!(Instant::now() < deadline, "supplier request did not arrive");
                    std::thread::sleep(Duration::from_millis(10));
                }
            };
            std::thread::scope(|scope| {
                let pending = scope.spawn(|| invoke("generate_brief_draft", serde_json::json!({"clientId":client,"instructions":"Cancel this synthetic brief", "requestId":cancelled_id})));
                wait_supplier(1);
                invoke(
                    "cancel_brief_draft",
                    serde_json::json!({"clientId":client,"requestId":cancelled_id}),
                )
                .unwrap();
                assert!(pending.join().unwrap().is_err());
            });
            assert_eq!(
                account_summary().unwrap()["briefsAvailable"].as_i64(),
                Some(before)
            );
            let completed_id = uuid::Uuid::new_v4().to_string();
            let completed = std::thread::scope(|scope| {
                let pending = scope.spawn(|| invoke("generate_brief_draft", serde_json::json!({"clientId":client,"instructions":"Complete this synthetic brief", "requestId":completed_id})));
                wait_supplier(2);
                assert!(invoke(
                    "cancel_brief_draft",
                    serde_json::json!({"clientId":client,"requestId":cancelled_id})
                )
                .is_err());
                std::fs::write(directory.join("supplier-release-2"), "release").unwrap();
                pending
                    .join()
                    .unwrap()
                    .unwrap()
                    .deserialize::<serde_json::Value>()
                    .unwrap()
            });
            assert!(std::path::Path::new(completed["documentPath"].as_str().unwrap()).is_file());
            assert!(invoke(
                "cancel_brief_draft",
                serde_json::json!({"clientId":client,"requestId":completed_id})
            )
            .is_err());
            assert_eq!(
                account_summary().unwrap()["briefsAvailable"].as_i64(),
                Some(before - 1)
            );
        }
        if brief_check {
            use tauri::Manager;
            let before = account_summary().unwrap();
            std::fs::write(directory.join("context-token-count"), "16001").unwrap();
            for (version, content) in [
                (101, "x".repeat(800_000)),
                (102, "# Imported brief\nReviewed short context".into()),
            ] {
                let brief = crate::imported_brief(
                    None,
                    version,
                    directory.join("imported.md"),
                    content,
                    "en".into(),
                );
                let state = app.state::<crate::AppState>();
                state.storage.lock().unwrap().save_brief(&brief).unwrap();
                let reviewed = crate::brief_document::load_reviewed(
                    &state.storage.lock().unwrap(),
                    brief.id,
                    None,
                    Some(&crate::sha256(&brief.document_content)),
                )
                .unwrap();
                let context = crate::build_context_pack(
                    &state,
                    None,
                    Some(brief.id),
                    &reviewed,
                    "en",
                    &[],
                    &[],
                )
                .unwrap();
                let session_id = uuid::Uuid::new_v4();
                prepare_session(&session_id.to_string()).unwrap();
                let error = meeting_context_request(session_id, &reviewed, &context)
                    .and_then(|request| check_meeting_context(&request))
                    .unwrap_err();
                stop_session(&session_id.to_string()).unwrap();
                assert!(error.starts_with("context_too_large:"), "{error}");
                assert!(state.live_meeting.lock().unwrap().is_none());
                assert!(!directory.join("recordings").exists());
            }
            let after = account_summary().unwrap();
            assert_eq!(after["briefsAvailable"], before["briefsAvailable"]);
            assert_eq!(after["meetingMsAvailable"], before["meetingMsAvailable"]);
            std::fs::remove_file(directory.join("context-token-count")).unwrap();
        }
        let product = std::env::var("SAVVY_E2E_PRODUCT").unwrap_or_else(|_| "account".into());
        let url = if product == "account" {
            None
        } else {
            Some(billing_url(&product, "desktop-monthly-e2e").unwrap())
        };
        std::fs::write(
            directory.join("desktop-result.json"),
            serde_json::to_vec_pretty(&serde_json::json!({"account":account,"url":url,"briefCancellation":if brief_check {"passed"} else {"not run"},"contextAdmission":if brief_check {"passed"} else {"not run"}})).unwrap(),
        )
        .unwrap();
        invoke("managed_sign_out", serde_json::json!({})).unwrap();
        assert!(account_summary().is_err());
        assert!(invoke("managed_account", serde_json::json!({}))
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap()
            .is_null());
        // Keep the process alive while the browser checks that asynchronous
        // server-side revocation removed its real Better Auth session.
        if std::env::var("SAVVY_E2E_WAIT_LOGOUT").as_deref() == Ok("1") {
            std::fs::write(directory.join("signed-out"), b"ready").unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !directory.join("logout-confirmed").exists() {
                assert!(Instant::now() < deadline, "browser session was not revoked");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        *ASYNC_TEST_CONTEXT.lock().unwrap() = None;
        TEST_CONTEXT.with(|current| *current.borrow_mut() = None);
    }

    #[test]
    fn fake_issuer_device_pending_rotating_refresh_and_logout_revocation() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let url = format!("http://{address}");
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let responses = Arc::new(Mutex::new(std::collections::VecDeque::<(
            u16,
            serde_json::Value,
        )>::new()));
        let revoke_status = Arc::new(AtomicU64::new(200));
        let worker_revoke_status = revoke_status.clone();
        let worker_responses = responses.clone();
        let worker_stop = stop.clone();
        let worker_requests = requests.clone();
        let issuer_url = url.clone();
        let worker = std::thread::spawn(move || {
            let mut polls = 0;
            while !worker_stop.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                loop {
                    let count = stream.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                    let text = String::from_utf8_lossy(&bytes);
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let length = head
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|v| v.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if body.len() >= length {
                            break;
                        }
                    }
                }
                let text = String::from_utf8(bytes).unwrap();
                worker_requests.lock().unwrap().push(text.clone());
                let (status, body) = if text.starts_with("GET /.well-known/openid-configuration ") {
                    (
                        200,
                        serde_json::json!({"issuer":issuer_url,"authorization_endpoint":format!("{issuer_url}/authorize"),"token_endpoint":format!("{issuer_url}/oauth/token"),"revocation_endpoint":format!("{issuer_url}/oauth/revoke"),"jwks_uri":format!("{issuer_url}/jwks")}),
                    )
                } else if text.starts_with("POST /oauth/device/code ") {
                    (
                        200,
                        serde_json::json!({"device_code":"private-device-fixture","user_code":"DISPLAY","verification_uri":format!("{issuer_url}/verify"),"interval":1,"expires_in":30}),
                    )
                } else if text.starts_with("POST /oauth/revoke ") {
                    (
                        worker_revoke_status.load(Ordering::SeqCst) as u16,
                        serde_json::json!({}),
                    )
                } else if let Some(response) = worker_responses.lock().unwrap().pop_front() {
                    response
                } else if text.contains("grant_type=urn%3Aietf") {
                    polls += 1;
                    if polls == 1 {
                        (400, serde_json::json!({"error":"authorization_pending"}))
                    } else {
                        (
                            200,
                            serde_json::json!({"access_token":"access-device","refresh_token":"refresh-one","expires_in":1}),
                        )
                    }
                } else {
                    assert!(text.contains("refresh_token=refresh-one"));
                    (
                        200,
                        serde_json::json!({"access_token":"access-refreshed","refresh_token":"refresh-two","expires_in":120}),
                    )
                };
                if let Some(delay) = body["fixtureDelayMs"].as_u64() {
                    std::thread::sleep(Duration::from_millis(delay));
                }
                if body["fixtureDropResponse"] == true {
                    continue;
                }
                let body = body.to_string();
                write!(stream,"HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        let context = TestContext {
            config: ManagedConfig {
                service_url: url.clone(),
                issuer_url: url,
                client_id: "fixture-native".into(),
                audience: "fixture-audience".into(),
            },
            credential: Arc::new(Mutex::new(None)),
            revocations: Arc::new(Mutex::new(vec![])),
            revocation_write_failure: Arc::new(AtomicBool::new(false)),
        };
        TEST_CONTEXT.with(|current| *current.borrow_mut() = Some(context.clone()));
        let mut browser = BrowserFlow {
            processing: false,
            credentials_accepted: false,
            id: "browser-test".into(),
            state: "state-test".into(),
            verifier: "verifier-test".into(),
            expires: Instant::now() + Duration::from_secs(60),
            generation: SIGN_IN_GENERATION.load(Ordering::SeqCst),
            config: context.config.clone(),
            metadata: Discovery {
                issuer: context.config.issuer_url.clone(),
                authorization_endpoint: String::new(),
                token_endpoint: String::new(),
                revocation_endpoint: String::new(),
                jwks_uri: String::new(),
            },
        };
        let mut callback = reqwest::Url::parse(CALLBACK).unwrap();
        callback.query_pairs_mut().extend_pairs([
            ("state", "state-test"),
            ("iss", browser.metadata.issuer.as_str()),
            ("code", "test-code"),
        ]);
        assert!(callback_parameters(callback.as_str(), &browser).is_ok());
        for invalid in [
            callback.as_str().replace("state-test", "wrong-state"),
            format!("{}&state=state-test", callback.as_str()),
            callback.as_str().replace("/oauth/callback", "/wrong"),
            format!("{}#fragment", callback.as_str()),
        ] {
            assert!(callback_parameters(&invalid, &browser).is_err());
        }
        // Reject an issuer's overflowing expiry before accepting credentials.
        browser.metadata.token_endpoint = format!("{}/oauth/token", context.config.issuer_url);
        *BROWSER_FLOW.lock().unwrap() = Some(browser.clone());
        let previous_refresh = stored_refresh_token().unwrap();
        responses.lock().unwrap().push_back((200, serde_json::json!({
            "access_token":"invalid-expiry-access", "refresh_token":"invalid-expiry-refresh", "expires_in":u64::MAX
        })));
        assert_eq!(
            finish_browser_callback(callback.as_str(), false).unwrap_err(),
            "invalid sign-in response"
        );
        assert_eq!(stored_refresh_token().unwrap(), previous_refresh);
        assert!(
            !BROWSER_FLOW
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .credentials_accepted
        );
        // A successful callback is the native commit point. Late cancellation
        // must fail without discarding credentials or the waiting result.
        browser.metadata.token_endpoint = format!("{}/oauth/token", context.config.issuer_url);
        *BROWSER_FLOW.lock().unwrap() = Some(browser.clone());
        responses.lock().unwrap().extend([
            (200, serde_json::json!({"access_token":"browser-access","refresh_token":"browser-refresh","expires_in":120})),
            (200, serde_json::json!({"identity":{"issuer":context.config.issuer_url,"subject":"browser-subject"}})),
        ]);
        finish_browser_callback(callback.as_str(), false).unwrap();
        let accepted_generation = SIGN_IN_GENERATION.load(Ordering::SeqCst);
        assert!(cancel_sign_in().unwrap_err().contains("already completed"));
        assert_eq!(
            SIGN_IN_GENERATION.load(Ordering::SeqCst),
            accepted_generation
        );
        assert_eq!(
            stored_refresh_token().unwrap().as_deref(),
            Some("browser-refresh")
        );
        assert!(BROWSER_RESULT.lock().unwrap().as_ref().unwrap().1.is_ok());
        clear_sign_in(true).unwrap();
        assert_eq!(
            stored_refresh_token().unwrap().as_deref(),
            Some("browser-refresh")
        );
        delete_refresh_token().unwrap();
        *ACCOUNT_IDENTITY.lock().unwrap() = None;
        *ACCESS_TOKEN.lock().unwrap() = None;

        // Cancellation must yield the UI thread while a credential commit waits.
        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let commit = std::thread::spawn(move || {
            let _guard = REFRESH_LOCK.lock().unwrap();
            locked_tx.send(()).unwrap();
            let _ = release_rx.recv_timeout(Duration::from_secs(2));
        });
        locked_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut cancellation = Box::pin(crate::managed_sign_in_cancel());
        let mut task = std::task::Context::from_waker(std::task::Waker::noop());
        let first_poll = std::future::Future::poll(cancellation.as_mut(), &mut task);
        let _ = release_tx.send(());
        commit.join().unwrap();
        assert!(
            first_poll.is_pending(),
            "cancellation blocked its dispatcher"
        );
        tauri::async_runtime::block_on(cancellation).unwrap();

        // Cancellation during token exchange wins before the commit lock.
        browser.generation = SIGN_IN_GENERATION.load(Ordering::SeqCst);
        *BROWSER_FLOW.lock().unwrap() = Some(browser.clone());
        responses.lock().unwrap().extend([
            (200, serde_json::json!({"access_token":"cancelled-access","refresh_token":"cancelled-refresh","expires_in":120,"fixtureDelayMs":300})),
            (200, serde_json::json!({"identity":{"issuer":context.config.issuer_url,"subject":"browser-subject"}})),
        ]);
        let exchange_count = requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.starts_with("POST /oauth/token "))
            .count();
        let worker_context = context.clone();
        let worker_callback = callback.to_string();
        let exchange = std::thread::spawn(move || {
            TEST_CONTEXT.with(|current| *current.borrow_mut() = Some(worker_context));
            finish_browser_callback(&worker_callback, false)
        });
        let started = Instant::now();
        while requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.starts_with("POST /oauth/token "))
            .count()
            == exchange_count
        {
            assert!(started.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(5));
        }
        cancel_sign_in().unwrap();
        assert!(exchange.join().unwrap().unwrap_err().contains("cancelled"));
        assert!(stored_refresh_token().unwrap().is_none());
        assert!(BROWSER_RESULT.lock().unwrap().is_none());
        browser.expires = Instant::now();
        assert!(callback_parameters(callback.as_str(), &browser).is_err());
        let authorization = start_device_authorization().unwrap();
        assert!(!serde_json::to_string(&authorization)
            .unwrap()
            .contains("private-device-fixture"));
        poll_device_authorization(&authorization).unwrap();
        assert_eq!(
            stored_refresh_token().unwrap().as_deref(),
            Some("refresh-one")
        );
        std::thread::sleep(Duration::from_millis(1100));
        let threads = (0..4)
            .map(|_| {
                let context = context.clone();
                std::thread::spawn(move || {
                    TEST_CONTEXT.with(|current| *current.borrow_mut() = Some(context));
                    access_token().unwrap()
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            assert_eq!(thread.join().unwrap(), "access-refreshed");
        }
        assert_eq!(
            stored_refresh_token().unwrap().as_deref(),
            Some("refresh-two")
        );
        // Exercise the authenticated transport used by the actual desktop billing command.
        responses.lock().unwrap().push_back((
            503,
            serde_json::json!({"code":"provider_unavailable","message":"unknown outcome"}),
        ));
        assert!(billing_url("pack", "same-attempt")
            .unwrap_err()
            .contains("provider_unavailable"));
        for _ in 0..2 {
            responses.lock().unwrap().push_back((
                200,
                serde_json::json!({"url":"https://checkout.stripe.com/c/pay/test#fragment"}),
            ));
            assert!(billing_url("pack", "same-attempt")
                .unwrap()
                .ends_with("#fragment"));
        }
        for raw in [
            "http://checkout.stripe.com/test",
            "https://checkout.stripe.com.attacker.example/test",
            "https://user:secret@checkout.stripe.com/test",
        ] {
            responses
                .lock()
                .unwrap()
                .push_back((200, serde_json::json!({"url":raw})));
            assert!(billing_url("pack", "same-attempt").is_err());
        }
        let billing_requests = requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.starts_with("POST /v1/billing/checkout "))
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(billing_requests.len(), 6);
        for request in billing_requests {
            assert!(request
                .to_lowercase()
                .contains("authorization: bearer access-refreshed"));
            let body: serde_json::Value =
                serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(
                body,
                serde_json::json!({"product":"pack","idempotencyKey":"same-attempt"})
            );
        }
        sign_out().unwrap();
        assert!(stored_refresh_token().unwrap().is_none());
        for _ in 0..100 {
            if requests
                .lock()
                .unwrap()
                .iter()
                .any(|r| r.starts_with("POST /oauth/revoke ") && r.contains("token=refresh-two"))
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            requests
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.contains("grant_type=refresh_token"))
                .count(),
            1
        );
        assert!(requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("token=refresh-two") && r.starts_with("POST /oauth/revoke ")));
        // Transient issuer failure keeps the rotating credential; invalid_grant removes it.
        store_refresh_token("refresh-one").unwrap();
        *ACCESS_TOKEN.lock().unwrap() = None;
        responses
            .lock()
            .unwrap()
            .push_back((500, serde_json::json!({"error":"temporarily_unavailable"})));
        assert!(access_token().unwrap_err().contains("provider_unavailable"));
        assert_eq!(
            stored_refresh_token().unwrap().as_deref(),
            Some("refresh-one")
        );
        responses
            .lock()
            .unwrap()
            .push_back((400, serde_json::json!({"error":"invalid_grant"})));
        assert!(access_token().unwrap_err().contains("sign_in_required"));
        assert!(stored_refresh_token().unwrap().is_none());
        for error in ["access_denied", "expired_token"] {
            let flow = start_device_authorization().unwrap();
            responses
                .lock()
                .unwrap()
                .push_back((400, serde_json::json!({"error":error})));
            assert!(poll_device_authorization(&flow).is_err());
            assert!(stored_refresh_token().unwrap().is_none());
        }
        // The issuer can require a slower polling cadence, then approve.
        let flow = start_device_authorization().unwrap();
        responses.lock().unwrap().extend([
            (400, serde_json::json!({"error":"slow_down"})),
            (200, serde_json::json!({"access_token":"access-slow","refresh_token":"refresh-slow","expires_in":120})),
        ]);
        let began = Instant::now();
        poll_device_authorization(&flow).unwrap();
        assert!(began.elapsed() >= Duration::from_secs(7));
        assert_eq!(
            stored_refresh_token().unwrap().as_deref(),
            Some("refresh-slow")
        );
        sign_out().unwrap();
        store_refresh_token("refresh-one").unwrap();
        responses.lock().unwrap().push_back((200,serde_json::json!({"access_token":"late-access","refresh_token":"late-refresh","expires_in":120,"fixtureDelayMs":300})));
        let refresh_context = context.clone();
        let before = requests.lock().unwrap().len();
        let late = std::thread::spawn(move || {
            TEST_CONTEXT.with(|current| *current.borrow_mut() = Some(refresh_context));
            access_token()
        });
        for _ in 0..100 {
            if requests.lock().unwrap().len() > before {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        sign_out().unwrap();
        assert!(late.join().unwrap().is_err());
        assert!(stored_refresh_token().unwrap().is_none());
        assert!(ACCESS_TOKEN.lock().unwrap().is_none());
        let flow = start_device_authorization().unwrap();
        let polling_context = context.clone();
        let polling = std::thread::spawn(move || {
            TEST_CONTEXT.with(|current| *current.borrow_mut() = Some(polling_context));
            poll_device_authorization(&flow)
        });
        std::thread::sleep(Duration::from_millis(100));
        sign_out().unwrap();
        assert!(polling.join().unwrap().is_err());
        assert!(stored_refresh_token().unwrap().is_none());
        let finish = |subject: &str, active: bool| {
            let mut flow = browser.clone();
            flow.processing = false;
            flow.expires = Instant::now() + Duration::from_secs(60);
            flow.generation = SIGN_IN_GENERATION.load(Ordering::SeqCst);
            flow.metadata.token_endpoint = format!("{}/oauth/token", context.config.issuer_url);
            flow.metadata.revocation_endpoint =
                format!("{}/oauth/revoke", context.config.issuer_url);
            responses.lock().unwrap().extend([
                (200,serde_json::json!({"access_token":"callback-access","refresh_token":format!("callback-{subject}"),"expires_in":120})),
                (200,serde_json::json!({"identity":{"issuer":context.config.issuer_url,"subject":subject}})),
            ]);
            *BROWSER_FLOW.lock().unwrap() = Some(flow);
            finish_browser_callback(callback.as_str(), active)
        };
        finish("account-a", false).unwrap();
        let audio_operation = ServiceOperation::begin_audio_check().unwrap();
        let generation = AUTH_GENERATION.load(Ordering::SeqCst);
        assert!(sign_out().unwrap_err().contains("Stop the audio check"));
        assert_eq!(AUTH_GENERATION.load(Ordering::SeqCst), generation);
        assert!(finish("account-b", false).is_err());
        assert_eq!(
            stored_refresh_token().unwrap().as_deref(),
            Some("callback-account-a")
        );
        assert_eq!(
            ACCOUNT_IDENTITY.lock().unwrap().as_ref().unwrap().1,
            "account-a"
        );
        drop(audio_operation);
        assert_eq!(AUDIO_CHECK_OPERATIONS.load(Ordering::SeqCst), 0);
        assert!(finish("account-b", true).is_err());
        assert_eq!(
            stored_refresh_token().unwrap().as_deref(),
            Some("callback-account-a")
        );
        store_refresh_token("same-identity-old-token").unwrap();
        finish("account-a", true).unwrap();
        drain_revocations().unwrap();
        assert!(requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.starts_with("POST /oauth/revoke ")
                && r.contains("token=same-identity-old-token")));
        assert_eq!(
            stored_refresh_token().unwrap().as_deref(),
            Some("callback-account-a")
        );
        let before = AUTH_GENERATION.load(Ordering::SeqCst);
        finish("account-b", false).unwrap();
        assert!(AUTH_GENERATION.load(Ordering::SeqCst) > before);
        assert_eq!(
            ACCOUNT_IDENTITY.lock().unwrap().as_ref().unwrap().1,
            "account-b"
        );
        assert!(finish_browser_callback(callback.as_str(), false).is_err());
        for text in ["x", "中", "😀", "\""] {
            let request = savvy_providers::BriefWireRequest {
                client_name: "size test".into(),
                instructions: text.repeat(savvy_providers::MAX_MANAGED_REQUEST_BYTES),
                guidance: vec![],
                client_evidence: vec![],
            };
            let before = requests.lock().unwrap().len();
            assert!(generate_brief(&request)
                .unwrap_err()
                .starts_with("context_too_large:"));
            // No supplier POST can be sent by an oversized brief.
            assert!(!requests.lock().unwrap()[before..]
                .iter()
                .any(|r| r.starts_with("POST /v1/briefs")));
        }
        let brief_request = |name: &str| savvy_providers::BriefWireRequest {
            client_name: name.into(),
            instructions: "fixture".into(),
            guidance: vec![],
            client_evidence: vec![],
        };
        let brief_response = serde_json::json!({"brief": {
            "title":"Paid brief", "objective":"Fixture", "responseLanguage":"en", "ourPosition":"", "clientPosition":"",
            "priorities":[], "agenda":[], "desiredOutcomes":[], "questionsToAsk":[], "factsToUse":[], "concessions":[],
            "redLines":[], "prohibitedClaims":[], "unauthorizedCommitments":[], "risks":[]
        }});
        let mut delayed = brief_response.clone();
        delayed["fixtureDelayMs"] = serde_json::json!(300);
        responses.lock().unwrap().push_back((200, delayed));
        let brief_context = context.clone();
        let request_a = brief_request("A");
        let threaded_request = request_a.clone();
        let before = requests.lock().unwrap().len();
        let pending_brief = std::thread::spawn(move || {
            TEST_CONTEXT.with(|current| *current.borrow_mut() = Some(brief_context));
            generate_brief(&threaded_request)
        });
        for _ in 0..100 {
            if requests.lock().unwrap()[before..]
                .iter()
                .any(|r| r.starts_with("POST /v1/briefs"))
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let generation = AUTH_GENERATION.load(Ordering::SeqCst);
        assert!(sign_out().unwrap_err().contains("brief"));
        assert_eq!(AUTH_GENERATION.load(Ordering::SeqCst), generation);
        assert!(generate_brief(&brief_request("B"))
            .unwrap_err()
            .contains("brief"));
        assert_eq!(pending_brief.join().unwrap().unwrap().title, "Paid brief");
        assert!(sign_out().unwrap_err().contains("brief"));
        let after = requests.lock().unwrap().len();
        assert_eq!(generate_brief(&request_a).unwrap().title, "Paid brief");
        assert_eq!(requests.lock().unwrap().len(), after);
        acknowledge_brief(&request_a);
        let ambiguous = brief_request("ambiguous-A");
        let other = brief_request("independent-B");
        responses.lock().unwrap().extend([
            (200, serde_json::json!({"fixtureDropResponse":true})),
            (200, serde_json::json!({"fixtureDropResponse":true})),
        ]);
        let before_ambiguous = requests.lock().unwrap().len();
        assert!(generate_brief(&ambiguous)
            .unwrap_err()
            .starts_with("could not reach the Savvy service"));
        assert!(sign_out().unwrap_err().contains("retrying"));
        responses
            .lock()
            .unwrap()
            .push_back((200, brief_response.clone()));
        generate_brief(&other).unwrap();
        acknowledge_brief(&other);
        responses
            .lock()
            .unwrap()
            .push_back((200, brief_response.clone()));
        generate_brief(&ambiguous).unwrap();
        acknowledge_brief(&ambiguous);
        let posted: Vec<serde_json::Value> = requests.lock().unwrap()[before_ambiguous..]
            .iter()
            .filter(|r| r.starts_with("POST /v1/briefs"))
            .map(|r| serde_json::from_str(r.split_once("\r\n\r\n").unwrap().1).unwrap())
            .collect();
        assert_eq!(posted.len(), 4);
        assert_eq!(posted[0]["idempotencyKey"], posted[1]["idempotencyKey"]);
        assert_eq!(posted[0]["idempotencyKey"], posted[3]["idempotencyKey"]);
        assert_ne!(posted[0]["idempotencyKey"], posted[2]["idempotencyKey"]);
        assert!(BRIEF_RETRY.lock().unwrap().is_empty());
        responses.lock().unwrap().push_back((
            402,
            serde_json::json!({"code":"quota_exhausted","message":"No brief allowance remains"}),
        ));
        assert!(generate_brief(&brief_request("no-allowance"))
            .unwrap_err()
            .starts_with("quota_exhausted:"));
        assert!(
            BRIEF_RETRY.lock().unwrap().is_empty(),
            "a rejected brief must not block sign-out"
        );

        let summary = serde_json::json!({
            "identity":{"issuer":context.config.issuer_url,"subject":"account-b"},
            "organization":{"id":"7","assignmentId":"11"},
            "organizationAllowance":{"totalMs":36000000,"usedMs":0}
        });
        let seat = FundingChoice::Organization {
            organization_id: "7".into(),
        };
        responses
            .lock()
            .unwrap()
            .extend([(200, summary.clone()), (200, summary.clone())]);
        let identity = ACCOUNT_IDENTITY.lock().unwrap().clone().unwrap();
        set_funding(seat.clone(), |key, value| {
            assert_eq!(key, preference_key(&identity).unwrap());
            assert_eq!(value, serde_json::to_value(&seat).unwrap());
            Ok(())
        })
        .unwrap();
        let session = serde_json::json!({"sessionId":"funded-session","state":"created","leaseVersion":1,"settledMs":0,"meetingMsAvailable":36000000,"warning":null,"funding":seat});
        responses
            .lock()
            .unwrap()
            .extend([(200, summary.clone()), (200, session.clone())]);
        prepare_session_with_funding("funded-session", Some(&seat)).unwrap();
        responses.lock().unwrap().push_back((200, summary.clone()));
        assert!(set_funding(FundingChoice::Personal {}, |_, _| panic!(
            "must not persist while prepared"
        ))
        .unwrap_err()
        .contains("funding_mismatch"));
        // Even an out-of-band preference change cannot consume a different payer's preparation.
        configure_funding_preferences(serde_json::json!({}));
        assert!(take_prepared("funded-session")
            .unwrap_err()
            .contains("funding_mismatch"));
        configure_funding_preferences(serde_json::json!({preference_key(&identity).unwrap():seat}));
        assert_eq!(
            take_prepared("funded-session").unwrap().0.funding,
            Some(seat.clone())
        );
        responses
            .lock()
            .unwrap()
            .extend([(200, session.clone()), (200, session.clone())]);
        stop_session("funded-session").unwrap();
        assert!(SESSION_FUNDING.lock().unwrap().is_empty());
        let funded_request = brief_request("organization-brief");
        responses
            .lock()
            .unwrap()
            .extend([(200, summary.clone()), (200, brief_response.clone())]);
        generate_brief(&funded_request).unwrap();
        let before = requests.lock().unwrap().len();
        generate_brief(&funded_request).unwrap();
        assert_eq!(
            requests.lock().unwrap().len(),
            before,
            "recovering a paid artifact does not recheck or spend a seat"
        );
        responses.lock().unwrap().push_back((200, summary.clone()));
        assert!(set_funding(FundingChoice::Personal {}, |_, _| panic!(
            "must preserve pending paid artifact"
        ))
        .is_err());
        acknowledge_brief(&funded_request);
        for (value, code) in [
            (
                serde_json::json!({"organization":null,"organizationAllowance":null}),
                "no_seat",
            ),
            (
                serde_json::json!({"briefsAvailable":5}),
                "funding_unavailable",
            ),
        ] {
            responses.lock().unwrap().push_back((200, value));
            let before = requests.lock().unwrap().len();
            assert!(generate_brief(&brief_request("removed-seat"))
                .unwrap_err()
                .contains(code));
            assert!(!requests.lock().unwrap()[before..]
                .iter()
                .any(|r| r.starts_with("POST /v1/briefs")));
            assert_eq!(selected_funding().unwrap(), seat);
        }
        let mut wrong_payer = session.clone();
        wrong_payer["funding"] = serde_json::json!({"kind":"personal"});
        responses.lock().unwrap().extend([
            (200, summary.clone()),
            (200, wrong_payer),
            (200, session.clone()),
        ]);
        assert!(create_session("wrong-payer")
            .unwrap_err()
            .contains("funding_mismatch"));
        assert!(!SESSION_FUNDING.lock().unwrap().contains_key("wrong-payer"));
        responses.lock().unwrap().push_back((200, summary.clone()));
        assert_eq!(
            set_funding(FundingChoice::Personal {}, |_, _| Err("disk full".into())).unwrap_err(),
            "disk full"
        );
        assert_eq!(selected_funding().unwrap(), seat);
        responses.lock().unwrap().push_back((200, summary));
        set_funding(FundingChoice::Personal {}, |_, _| Ok(())).unwrap();
        for wire in requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.starts_with("POST /v1/briefs") || r.starts_with("POST /v1/sessions "))
        {
            let body: serde_json::Value =
                serde_json::from_str(wire.split_once("\r\n\r\n").unwrap().1).unwrap();
            if body["request"]["clientName"] == "organization-brief"
                || body["sessionId"] == "funded-session"
            {
                assert_eq!(body["funding"], serde_json::to_value(&seat).unwrap());
            }
        }
        *ACCESS_TOKEN.lock().unwrap() = None;
        let previous_refresh = stored_refresh_token().unwrap();
        responses.lock().unwrap().push_back((200, serde_json::json!({
            "access_token":"invalid-refresh-access", "refresh_token":"invalid-rotated-refresh", "expires_in":u64::MAX
        })));
        assert!(access_token().unwrap_err().contains("unexpected response"));
        assert_eq!(stored_refresh_token().unwrap(), previous_refresh);
        assert!(ACCESS_TOKEN.lock().unwrap().is_none());
        sign_out().unwrap();
        drain_revocations().unwrap();
        revoke_status.store(503, Ordering::SeqCst);
        store_refresh_token("offline-logout-token").unwrap();
        sign_out().unwrap();
        drain_revocations().unwrap();
        assert!(stored_refresh_token().unwrap().is_none());
        assert!(ACCESS_TOKEN.lock().unwrap().is_none());
        assert!(read_revocations()
            .unwrap()
            .iter()
            .any(|record| record.token == "offline-logout-token"));
        // Rehydrate the durable record, without restoring an authorizing token.
        let saved = serde_json::to_vec(&read_revocations().unwrap()).unwrap();
        *context.revocations.lock().unwrap() = serde_json::from_slice(&saved).unwrap();
        revoke_status.store(302, Ordering::SeqCst);
        drain_revocations().unwrap();
        assert!(!read_revocations().unwrap().is_empty());
        // Crash between enqueue and deleting the old Keychain credential.
        store_refresh_token("crash-before-delete-token").unwrap();
        queue_revocation(context.config.clone(), "crash-before-delete-token".into()).unwrap();
        assert!(stored_refresh_token().unwrap().is_none());
        revoke_status.store(200, Ordering::SeqCst);
        drain_revocations().unwrap();
        assert!(read_revocations().unwrap().is_empty());
        assert!(read_refresh_token().unwrap().is_none());
        store_refresh_token("keychain-failure-token").unwrap();
        context
            .revocation_write_failure
            .store(true, Ordering::SeqCst);
        assert!(sign_out().unwrap_err().contains("Keychain write failure"));
        assert_eq!(
            read_refresh_token().unwrap().as_deref(),
            Some("keychain-failure-token")
        );
        context
            .revocation_write_failure
            .store(false, Ordering::SeqCst);
        sign_out().unwrap();
        drain_revocations().unwrap();
        assert!(read_revocations().unwrap().is_empty());
        assert!(read_refresh_token().unwrap().is_none());
        TEST_CONTEXT.with(|current| *current.borrow_mut() = None);
        stop.store(true, Ordering::SeqCst);
        worker.join().unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn funding_preferences_are_strict_and_bound_to_verified_identity() {
        let a = ("https://issuer-a.example".into(), "person".into());
        let b = ("https://issuer-b.example".into(), "person".into());
        let c = ("https://issuer-a.example".into(), "other".into());
        let seat = FundingChoice::Organization {
            organization_id: "42".into(),
        };
        let mut preferences = serde_json::json!({});
        preferences[preference_key(&a).unwrap()] = serde_json::to_value(&seat).unwrap();
        assert_eq!(funding_for_identity(&preferences, Some(&a)).unwrap(), seat);
        for identity in [&b, &c] {
            assert_eq!(
                funding_for_identity(&preferences, Some(identity)).unwrap(),
                FundingChoice::Personal {}
            );
        }
        let repaired =
            serde_json::json!({"__invalid_preferences":true,preference_key(&a).unwrap():seat});
        assert_eq!(funding_for_identity(&repaired, Some(&a)).unwrap(), seat);
        assert!(
            funding_for_identity(&repaired, Some(&b)).is_err(),
            "repairing one identity must not reset another person's corrupt payer to personal"
        );
        assert!(funding_for_identity(&preferences, None).is_err());
        assert_eq!(
            funding_for_identity(&serde_json::json!({}), None).unwrap(),
            FundingChoice::Personal {}
        );
        for invalid in [
            serde_json::json!(null),
            serde_json::json!([]),
            serde_json::json!("personal"),
        ] {
            assert!(funding_for_identity(&invalid, Some(&a)).is_err());
            preferences[preference_key(&a).unwrap()] = invalid;
            assert!(funding_for_identity(&preferences, Some(&a)).is_err());
        }
        for id in ["0", "-1", "01", "+1", " 1", "1.0", "9223372036854775808"] {
            assert!(
                FundingChoice::Organization {
                    organization_id: id.into()
                }
                .validate()
                .is_err(),
                "{id}"
            );
        }
        for invalid in [
            serde_json::json!({"kind":"organization","organizationId":42}),
            serde_json::json!({"kind":"personal","organizationId":"42"}),
            serde_json::json!({"kind":"unknown"}),
        ] {
            assert!(serde_json::from_value::<FundingChoice>(invalid).is_err());
        }
        let request = savvy_providers::BriefWireRequest {
            client_name: "Test".into(),
            instructions: "Test".into(),
            guidance: vec![],
            client_evidence: vec![],
        };
        let binding = FundingBinding {
            choice: seat,
            identity: Some(a),
            generation: 1,
        };
        let original = brief_digest(&request, &binding).unwrap();
        assert_ne!(
            original,
            brief_digest(
                &request,
                &FundingBinding {
                    choice: FundingChoice::Personal {},
                    ..binding.clone()
                }
            )
            .unwrap()
        );
        assert_ne!(
            original,
            brief_digest(
                &request,
                &FundingBinding {
                    identity: Some(b),
                    ..binding
                }
            )
            .unwrap()
        );
    }

    #[test]
    fn token_response_rejects_invalid_expiry_before_acceptance() {
        for expiry in [
            serde_json::json!(0),
            serde_json::json!(86_401),
            serde_json::json!(u64::MAX),
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!("3600"),
        ] {
            let response = serde_json::json!({"access_token":"fixture-access","refresh_token":"fixture-refresh","expires_in":expiry});
            assert!(
                serde_json::from_value::<TokenResponse>(response).is_err(),
                "accepted expiry {expiry}"
            );
        }
        for expiry in [1, 600, 3600, 86_400] {
            let response = serde_json::json!({"access_token":"fixture-access","expires_in":expiry});
            assert_eq!(
                serde_json::from_value::<TokenResponse>(response)
                    .unwrap()
                    .expires_in,
                expiry
            );
        }
        assert_eq!(
            serde_json::from_value::<TokenResponse>(
                serde_json::json!({"access_token":"fixture-access"})
            )
            .unwrap()
            .expires_in,
            600
        );
    }

    #[test]
    fn typed_errors_carry_a_stable_code_prefix() {
        assert!(sign_in_required_error().starts_with("sign_in_required: "));
        assert!(!sign_in_required_error().contains("API key"));
    }

    #[test]
    fn production_urls_must_be_https_but_loopback_dev_is_allowed() {
        assert!(require_trusted_url("https://api.savvycopilot.com").is_ok());
        assert!(require_trusted_url("http://127.0.0.1:8787").is_ok());
        assert!(require_trusted_url("http://localhost:8787").is_ok());
        for url in [
            "http://api.savvy.example",
            "http://localhost.attacker.example",
            "http://127.0.0.1.attacker.example",
            "https://user:password@example.com",
            "https://example.com/#token",
        ] {
            assert!(require_trusted_url(url).is_err(), "{url}");
        }
    }
}
