//! Explicit, bounded capture checks. No recording or meeting is created locally.
use crate::{managed, settings::AppSettings};
use savvy_audio::{AudioCapture, AudioSource, MicrophoneCapture, SystemAudioCapture};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

static ACTIVE: AtomicBool = AtomicBool::new(false);
static STOP: Mutex<Option<(String, watch::Sender<bool>)>> = Mutex::new(None);
pub fn active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}
pub fn stop(id: &str) -> Result<(), String> {
    if let Some((active_id, sender)) = STOP.lock().map_err(|_| "audio check lock")?.as_ref() {
        if id == active_id {
            let _ = sender.send(true);
        }
    }
    Ok(())
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckEvent {
    id: String,
    status: &'static str,
    microphone_level: f32,
    system_level: f32,
    message: String,
    transcript: Option<String>,
}
pub fn start(
    app: AppHandle,
    settings: AppSettings,
    transcribe: bool,
    key: Option<String>,
    id: uuid::Uuid,
) -> Result<String, String> {
    let account_operation = if transcribe && settings.service_mode == "managed" {
        Some(managed::ServiceOperation::begin_audio_check()?)
    } else {
        None
    };
    let mut stop_slot = STOP.lock().map_err(|_| "audio check lock")?;
    if ACTIVE.swap(true, Ordering::SeqCst) {
        return Err("an audio check is already running".into());
    }
    let id = id.to_string();
    let worker_id = id.clone();
    let (sender, mut stopped) = watch::channel(false);
    *stop_slot = Some((id.clone(), sender.clone()));
    drop(stop_slot);
    tauri::async_runtime::spawn_blocking(move || {
        // Keep the original account fixed until hosted cleanup has completed.
        let _account_operation = account_operation;
        let mut mic = MicrophoneCapture::new();
        let mut system = SystemAudioCapture::new();
        let mut managed_started = false;
        let mut cancelled = false;
        let emit = |status,
                    microphone_level,
                    system_level,
                    message: String,
                    transcript: Option<String>| {
            let _ = app.emit(
                "audio-check://status",
                CheckEvent {
                    id: worker_id.clone(),
                    status,
                    microphone_level,
                    system_level,
                    message,
                    transcript,
                },
            );
        };
        let result = (|| -> Result<Option<String>, String> {
            mic.configure(
                settings.selected_microphone.clone(),
                settings.selected_channel,
            )
            .map_err(|e| e.to_string())?;
            let mut lease = 0;
            let credentials = if transcribe && settings.service_mode == "managed" {
                lease = managed::create_session(&worker_id)?.lease_version;
                managed_started = true;
                Some(managed::relay_credentials()?)
            } else {
                None
            };
            if *stopped.borrow() {
                return Ok(None);
            }
            mic.start().map_err(|e| e.to_string())?;
            let mic_frames = mic.frames();
            let system_frames = if settings.microphone_only {
                None
            } else {
                system.start().map_err(|e| e.to_string())?;
                Some(system.frames())
            };
            let (transcripts, mut received) = tokio::sync::mpsc::channel(64);
            let mut jobs = Vec::new();
            let (errors, mut failures) = tokio::sync::mpsc::unbounded_channel();
            if transcribe {
                for (source, frames) in [
                    (AudioSource::Microphone, Some(mic_frames.clone())),
                    (AudioSource::System, system_frames.clone()),
                ] {
                    let Some(frames) = frames else { continue };
                    let settings = settings.clone();
                    let key = key.clone();
                    let credentials = credentials.clone();
                    let id = worker_id.clone();
                    let stop = stopped.clone();
                    let transcripts = transcripts.clone();
                    let errors = errors.clone();
                    jobs.push(tauri::async_runtime::spawn(async move {
                        let result = if let Some((url, token)) = credentials {
                            savvy_transcription::stream_managed_transcription(
                                &url,
                                &id,
                                &token,
                                &settings.transcription_language,
                                lease,
                                frames,
                                stop,
                                transcripts,
                                source,
                            )
                            .await
                        } else {
                            let provider = if settings.transcription_provider == "deepgram" {
                                savvy_transcription::StreamingProvider::Deepgram
                            } else {
                                savvy_transcription::StreamingProvider::AssemblyAi
                            };
                            savvy_transcription::stream_transcription(
                                provider,
                                &settings.transcription_model,
                                &settings.transcription_language,
                                key.as_deref().unwrap_or(""),
                                frames,
                                stop,
                                transcripts,
                                source,
                            )
                            .await
                        };
                        if let Err(error) = result {
                            let _ = errors.send(error.to_string());
                        }
                    }));
                }
            }
            let deadline = Instant::now() + Duration::from_secs(30);
            let result = tauri::async_runtime::block_on(async {
                loop {
                    if *stopped.borrow() || Instant::now() >= deadline {
                        return Ok(None);
                    }
                    if !transcribe {
                        while mic_frames.try_recv().is_ok() {}
                        if let Some(frames) = &system_frames {
                            while frames.try_recv().is_ok() {}
                        }
                    }
                    emit(
                        "listening",
                        mic.level().map_err(|e| e.to_string())?,
                        system.level().map_err(|e| e.to_string())?,
                        String::new(),
                        None,
                    );
                    tokio::select! {
                        _ = stopped.changed() => return Ok(None),
                        Some(transcript) = received.recv(), if transcribe => {
                            if !transcript.text.trim().is_empty() { return Ok(Some(transcript.text)); }
                        },
                        _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                    }
                    if let Ok(error) = failures.try_recv() {
                        return Err(error);
                    }
                }
            });
            cancelled = *stopped.borrow();
            let _ = sender.send(true);
            let _ = mic.stop();
            let _ = system.stop();
            tauri::async_runtime::block_on(async {
                for mut job in jobs {
                    if tokio::time::timeout(Duration::from_secs(2), &mut job)
                        .await
                        .is_err()
                    {
                        job.abort();
                    }
                }
            });
            result
        })();

        let _ = sender.send(true);
        let _ = mic.stop();
        let _ = system.stop();
        if managed_started {
            let _ = managed::stop_session(&worker_id);
        }
        let transcript = result.as_ref().ok().and_then(|text| text.clone());
        let (status, message) = match result {
            Ok(Some(_)) => ("passed", "A real transcript was received.".into()),
            Ok(None) if cancelled => ("cancelled", "Audio check stopped.".into()),
            Ok(None) => (
                "finished",
                if transcribe {
                    "No transcript received. Check your input and try again.".into()
                } else {
                    "Signal check finished. Transcription has not been tested.".into()
                },
            ),
            Err(error) => ("failed", error),
        };
        if let Ok(mut slot) = STOP.lock() {
            *slot = None;
        }
        ACTIVE.store(false, Ordering::SeqCst);
        emit(status, 0.0, 0.0, message, transcript);
    });
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_stop_cannot_cancel_a_different_audio_check() {
        let (sender, receiver) = watch::channel(false);
        *STOP.lock().unwrap() = Some(("current-check".into(), sender));
        stop("previous-check").unwrap();
        assert!(!*receiver.borrow());
        stop("current-check").unwrap();
        assert!(*receiver.borrow());
        *STOP.lock().unwrap() = None;
    }
}
