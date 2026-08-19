use flume::Receiver;
use futures_util::{SinkExt, StreamExt};
use savvy_audio::{downmix_to_mono, AudioFrame, AudioSource};
use savvy_domain::SpeakerChannel;
use serde_json::Value;
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::{mpsc::UnboundedSender, watch};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};

#[derive(Debug, Error)]
pub enum TranscriptionError {
    #[error("transcription failed: {0}")]
    Failed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamingProvider {
    Deepgram,
    AssemblyAi,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LiveTranscript {
    pub kind: TranscriptEventKind,
    pub source: AudioSource,
    pub text: String,
    pub language: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub confidence: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptEventKind {
    Interim,
    SegmentFinal,
    TurnFinal,
    UtteranceEnd,
}

const MICROPHONE_FINAL_HOLD: Duration = Duration::from_millis(3_500);
const ECHO_MATCH_WINDOW_MS: u64 = 4_500;
const SHORT_ECHO_MATCH_WINDOW_MS: u64 = 1_500;
const ECHO_HISTORY: Duration = Duration::from_millis(6_000);

#[derive(Debug)]
struct TimedTranscript {
    transcript: LiveTranscript,
    received_at: Instant,
}

#[derive(Debug, PartialEq)]
pub enum ReconciledTranscript {
    Emit(LiveTranscript),
    Suppressed { score: f32, delta_ms: u64 },
}

#[derive(Debug)]
pub struct CrossStreamReconciler {
    system_available: bool,
    recent_system: VecDeque<TimedTranscript>,
    pending_microphone: VecDeque<TimedTranscript>,
}

impl CrossStreamReconciler {
    pub fn new(system_available: bool) -> Self {
        Self {
            system_available,
            recent_system: VecDeque::new(),
            pending_microphone: VecDeque::new(),
        }
    }

    pub fn push(&mut self, transcript: LiveTranscript, now: Instant) -> Vec<ReconciledTranscript> {
        if !self.system_available {
            return vec![ReconciledTranscript::Emit(transcript)];
        }
        self.prune_system(now);
        match transcript.source {
            AudioSource::Microphone => {
                if let Some((score, delta_ms)) = echo_match(&transcript, &self.recent_system) {
                    vec![ReconciledTranscript::Suppressed { score, delta_ms }]
                } else {
                    self.pending_microphone.push_back(TimedTranscript {
                        transcript,
                        received_at: now,
                    });
                    Vec::new()
                }
            }
            AudioSource::System => {
                self.recent_system.push_back(TimedTranscript {
                    transcript: transcript.clone(),
                    received_at: now,
                });
                let mut output = vec![ReconciledTranscript::Emit(transcript)];
                let mut index = 0;
                while index < self.pending_microphone.len() {
                    let matched = echo_match(
                        &self.pending_microphone[index].transcript,
                        &self.recent_system,
                    );
                    if let Some((score, delta_ms)) = matched {
                        self.pending_microphone.remove(index);
                        output.push(ReconciledTranscript::Suppressed { score, delta_ms });
                    } else {
                        index += 1;
                    }
                }
                output
            }
        }
    }

    pub fn flush_due(&mut self, now: Instant) -> Vec<ReconciledTranscript> {
        let mut output = Vec::new();
        while self
            .pending_microphone
            .front()
            .is_some_and(|pending| now.duration_since(pending.received_at) >= MICROPHONE_FINAL_HOLD)
        {
            if let Some(pending) = self.pending_microphone.pop_front() {
                output.push(ReconciledTranscript::Emit(pending.transcript));
            }
        }
        self.prune_system(now);
        output
    }

    pub fn drain_pending(&mut self) -> Vec<ReconciledTranscript> {
        self.pending_microphone
            .drain(..)
            .map(|pending| ReconciledTranscript::Emit(pending.transcript))
            .collect()
    }

    fn prune_system(&mut self, now: Instant) {
        while self
            .recent_system
            .front()
            .is_some_and(|item| now.duration_since(item.received_at) > ECHO_HISTORY)
        {
            self.recent_system.pop_front();
        }
    }
}

fn echo_match(
    microphone: &LiveTranscript,
    system: &VecDeque<TimedTranscript>,
) -> Option<(f32, u64)> {
    let microphone_words = normalized_words(&microphone.text);
    if microphone_words.is_empty() {
        return None;
    }
    let candidates = system
        .iter()
        .filter(|candidate| {
            interval_gap_ms(microphone, &candidate.transcript) <= ECHO_MATCH_WINDOW_MS
        })
        .collect::<Vec<_>>();
    if microphone_words.len() <= 2 {
        return candidates.iter().find_map(|candidate| {
            let words = normalized_words(&candidate.transcript.text);
            let delta_ms = interval_gap_ms(microphone, &candidate.transcript);
            (words == microphone_words && delta_ms <= SHORT_ECHO_MATCH_WINDOW_MS)
                .then_some((1.0, delta_ms))
        });
    }
    let delta_ms = candidates
        .iter()
        .map(|candidate| interval_gap_ms(microphone, &candidate.transcript))
        .min()?;
    let system_words = candidates
        .iter()
        .flat_map(|candidate| normalized_words(&candidate.transcript.text))
        .collect::<Vec<_>>();
    let score = ordered_token_coverage(&microphone_words, &system_words);
    (score >= 0.70).then_some((score, delta_ms))
}

fn normalized_words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

fn ordered_token_coverage(left: &[String], right: &[String]) -> f32 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let mut previous = vec![0usize; right.len() + 1];
    for left_word in left {
        let mut current = vec![0usize; right.len() + 1];
        for (index, right_word) in right.iter().enumerate() {
            current[index + 1] = if left_word == right_word {
                previous[index] + 1
            } else {
                current[index].max(previous[index + 1])
            };
        }
        previous = current;
    }
    previous[right.len()] as f32 / left.len().min(right.len()) as f32
}

fn interval_gap_ms(left: &LiveTranscript, right: &LiveTranscript) -> u64 {
    if left.end_ms < right.start_ms {
        right.start_ms - left.end_ms
    } else {
        left.start_ms.saturating_sub(right.end_ms)
    }
}

#[derive(Debug)]
struct PendingTurn {
    parts: Vec<String>,
    language: String,
    start_ms: u64,
    end_ms: u64,
    confidence_sum: f32,
    confidence_count: u32,
    updated_at: std::time::Instant,
}

#[derive(Debug, Default)]
pub struct TurnAssembler {
    microphone: Option<PendingTurn>,
    system: Option<PendingTurn>,
}

impl TurnAssembler {
    pub fn push(&mut self, event: LiveTranscript) -> Option<LiveTranscript> {
        match event.kind {
            TranscriptEventKind::Interim => None,
            TranscriptEventKind::UtteranceEnd => self.finish(event.source),
            TranscriptEventKind::SegmentFinal | TranscriptEventKind::TurnFinal => {
                let source = event.source;
                let complete = event.kind == TranscriptEventKind::TurnFinal;
                let pending = self.pending_mut(source);
                if pending.is_none() {
                    *pending = Some(PendingTurn {
                        parts: Vec::new(),
                        language: event.language.clone(),
                        start_ms: event.start_ms,
                        end_ms: event.end_ms,
                        confidence_sum: 0.0,
                        confidence_count: 0,
                        updated_at: std::time::Instant::now(),
                    });
                }
                let pending = pending.as_mut().expect("pending turn initialized");
                if !event.text.trim().is_empty()
                    && pending.parts.last().is_none_or(|part| part != &event.text)
                {
                    pending.parts.push(event.text);
                    pending.confidence_sum += event.confidence;
                    pending.confidence_count += 1;
                }
                pending.language = event.language;
                pending.start_ms = pending.start_ms.min(event.start_ms);
                pending.end_ms = pending.end_ms.max(event.end_ms);
                pending.updated_at = std::time::Instant::now();
                complete.then(|| self.finish(source)).flatten()
            }
        }
    }

    pub fn flush_expired(&mut self, idle: std::time::Duration) -> Vec<LiveTranscript> {
        let now = std::time::Instant::now();
        let mut completed = Vec::new();
        for source in [AudioSource::Microphone, AudioSource::System] {
            let expired = self
                .pending(source)
                .as_ref()
                .is_some_and(|pending| now.duration_since(pending.updated_at) >= idle);
            if expired {
                completed.extend(self.finish(source));
            }
        }
        completed
    }

    fn pending(&self, source: AudioSource) -> &Option<PendingTurn> {
        match source {
            AudioSource::Microphone => &self.microphone,
            AudioSource::System => &self.system,
        }
    }

    fn pending_mut(&mut self, source: AudioSource) -> &mut Option<PendingTurn> {
        match source {
            AudioSource::Microphone => &mut self.microphone,
            AudioSource::System => &mut self.system,
        }
    }

    fn finish(&mut self, source: AudioSource) -> Option<LiveTranscript> {
        let pending = self.pending_mut(source).take()?;
        let text = pending.parts.join(" ");
        (!text.trim().is_empty()).then(|| LiveTranscript {
            kind: TranscriptEventKind::TurnFinal,
            source,
            text,
            language: pending.language,
            start_ms: pending.start_ms,
            end_ms: pending.end_ms,
            confidence: pending.confidence_sum / pending.confidence_count.max(1) as f32,
        })
    }
}

const STREAMING_CHUNK_BYTES: usize = 1_600;

#[allow(clippy::too_many_arguments)]
pub async fn stream_transcription(
    provider: StreamingProvider,
    model: &str,
    language: &str,
    api_key: &str,
    frames: Receiver<AudioFrame>,
    mut stop: watch::Receiver<bool>,
    transcripts: UnboundedSender<LiveTranscript>,
    source: AudioSource,
) -> Result<(), TranscriptionError> {
    if api_key.trim().is_empty() {
        return Err(TranscriptionError::Failed("API key is empty".into()));
    }
    let url = streaming_url(provider, model, language);
    let mut request = url
        .into_client_request()
        .map_err(|_| TranscriptionError::Failed("invalid provider endpoint".into()))?;
    let authorization = match provider {
        StreamingProvider::Deepgram => format!("Token {api_key}"),
        StreamingProvider::AssemblyAi => api_key.to_owned(),
    };
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&authorization)
            .map_err(|_| TranscriptionError::Failed("invalid API key".into()))?,
    );
    let (socket, _) =
        tokio::time::timeout(std::time::Duration::from_secs(10), connect_async(request))
            .await
            .map_err(|_| TranscriptionError::Failed("provider connection timed out".into()))?
            .map_err(|error| {
                TranscriptionError::Failed(format!("provider connection failed: {error}"))
            })?;
    let (mut writer, mut reader) = socket.split();
    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(5));
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    keepalive.tick().await;
    let mut audio_buffer = Vec::with_capacity(STREAMING_CHUNK_BYTES * 2);

    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_ok() && !*stop.borrow() {
                    continue;
                }
                let close = match provider {
                    StreamingProvider::Deepgram => r#"{"type":"CloseStream"}"#,
                    StreamingProvider::AssemblyAi => r#"{"type":"Terminate"}"#,
                };
                let _ = writer.send(Message::Text(close.into())).await;
                let _ = writer.close().await;
                return Ok(());
            }
            _ = keepalive.tick() => {
                let keepalive = match provider {
                    StreamingProvider::Deepgram => Message::Text(r#"{"type":"KeepAlive"}"#.into()),
                    StreamingProvider::AssemblyAi => Message::Ping(Vec::new().into()),
                };
                writer.send(keepalive).await
                    .map_err(|error| TranscriptionError::Failed(format!("provider keepalive failed: {error}")))?;
            }
            frame = frames.recv_async() => {
                let frame = frame.map_err(|_| TranscriptionError::Failed("microphone stream ended".into()))?;
                audio_buffer.extend(frame_to_pcm16(&frame));
                while let Some(chunk) = take_streaming_chunk(&mut audio_buffer) {
                    writer.send(Message::Binary(chunk.into())).await
                        .map_err(|error| TranscriptionError::Failed(format!("provider audio send failed: {error}")))?;
                }
            }
            message = reader.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if let Some(error) = parse_provider_error(text.as_ref()) {
                            return Err(TranscriptionError::Failed(error));
                        }
                        if let Some(transcript) = parse_provider_message(provider, text.as_ref(), language, source) {
                            let _ = transcripts.send(transcript);
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        writer.send(Message::Pong(payload)).await
                            .map_err(|error| TranscriptionError::Failed(format!("provider keepalive failed: {error}")))?;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        return Err(TranscriptionError::Failed("provider connection closed".into()));
                    }
                    Some(Err(error)) => {
                        return Err(TranscriptionError::Failed(format!("provider receive failed: {error}")));
                    }
                    _ => {}
                }
            }
        }
    }
}

fn take_streaming_chunk(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    if buffer.len() < STREAMING_CHUNK_BYTES {
        return None;
    }
    let remaining = buffer.split_off(STREAMING_CHUNK_BYTES);
    Some(std::mem::replace(buffer, remaining))
}

fn parse_provider_error(message: &str) -> Option<String> {
    let value: Value = serde_json::from_str(message).ok()?;
    (value.get("type").and_then(Value::as_str) == Some("Error")).then(|| {
        value
            .get("error")
            .or_else(|| value.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("provider rejected the transcription session")
            .to_owned()
    })
}

fn streaming_url(provider: StreamingProvider, model: &str, language: &str) -> String {
    match provider {
        StreamingProvider::Deepgram => format!(
            "wss://api.deepgram.com/v1/listen?model={model}&language={language}&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&smart_format=true&punctuate=true&endpointing=300&utterance_end_ms=1000&mip_opt_out=true"
        ),
        StreamingProvider::AssemblyAi => {
            let mut url = format!(
                "wss://streaming.assemblyai.com/v3/ws?speech_model={model}&sample_rate=16000"
            );
            if model == "u3-rt-pro" {
                if let Some(name) = forced_language_name(language) {
                    url.push_str(&format!("&prompt=Transcribe%20{name}."));
                }
            }
            url
        }
    }
}

fn forced_language_name(language: &str) -> Option<&'static str> {
    match language {
        "en" => Some("English"),
        "es" => Some("Spanish"),
        "fr" => Some("French"),
        "de" => Some("German"),
        "it" => Some("Italian"),
        "pt" => Some("Portuguese"),
        _ => None,
    }
}

fn transcript_language(configured: &str, detected: Option<&str>) -> String {
    if configured == "multi" {
        detected.unwrap_or(configured)
    } else {
        configured
    }
    .to_owned()
}

pub fn frame_to_pcm16(frame: &AudioFrame) -> Vec<u8> {
    prepare_frame(frame)
        .into_iter()
        .flat_map(|sample| {
            let sample = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
            sample.to_le_bytes()
        })
        .collect()
}

fn parse_provider_message(
    provider: StreamingProvider,
    message: &str,
    configured_language: &str,
    source: AudioSource,
) -> Option<LiveTranscript> {
    let value: Value = serde_json::from_str(message).ok()?;
    match provider {
        StreamingProvider::Deepgram => parse_deepgram(value, configured_language, source),
        StreamingProvider::AssemblyAi => parse_assembly_ai(value, configured_language, source),
    }
}

fn parse_deepgram(
    value: Value,
    configured_language: &str,
    source: AudioSource,
) -> Option<LiveTranscript> {
    let message_type = value.get("type")?.as_str()?;
    if message_type == "UtteranceEnd" {
        return Some(LiveTranscript {
            kind: TranscriptEventKind::UtteranceEnd,
            source,
            text: String::new(),
            language: configured_language.to_owned(),
            start_ms: 0,
            end_ms: 0,
            confidence: 0.0,
        });
    }
    if message_type != "Results" {
        return None;
    }
    let alternative = value.get("channel")?.get("alternatives")?.get(0)?;
    let text = alternative.get("transcript")?.as_str()?.trim();
    let is_final = value
        .get("is_final")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let speech_final = value
        .get("speech_final")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if text.is_empty() && !speech_final {
        return None;
    }
    let start_ms = seconds_to_ms(value.get("start").and_then(Value::as_f64).unwrap_or(0.0));
    let duration_ms = seconds_to_ms(value.get("duration").and_then(Value::as_f64).unwrap_or(0.0));
    Some(LiveTranscript {
        kind: if speech_final {
            TranscriptEventKind::TurnFinal
        } else if is_final {
            TranscriptEventKind::SegmentFinal
        } else {
            TranscriptEventKind::Interim
        },
        source,
        text: text.to_owned(),
        language: transcript_language(
            configured_language,
            value
                .get("channel")
                .and_then(|channel| channel.get("detected_language"))
                .and_then(Value::as_str),
        ),
        start_ms,
        end_ms: start_ms + duration_ms,
        confidence: alternative
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or(0.0) as f32,
    })
}

fn parse_assembly_ai(
    value: Value,
    configured_language: &str,
    source: AudioSource,
) -> Option<LiveTranscript> {
    if value.get("type")?.as_str()? != "Turn" {
        return None;
    }
    let text = value.get("transcript")?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    let words = value.get("words").and_then(Value::as_array);
    let start_ms = words
        .and_then(|words| words.first())
        .and_then(|word| word.get("start"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let end_ms = words
        .and_then(|words| words.last())
        .and_then(|word| word.get("end"))
        .and_then(Value::as_u64)
        .unwrap_or(start_ms);
    let confidence = words
        .map(|words| {
            let values = words
                .iter()
                .filter_map(|word| word.get("confidence").and_then(Value::as_f64))
                .collect::<Vec<_>>();
            if values.is_empty() {
                0.0
            } else {
                (values.iter().sum::<f64>() / values.len() as f64) as f32
            }
        })
        .unwrap_or(0.0);
    Some(LiveTranscript {
        kind: if value
            .get("end_of_turn")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            TranscriptEventKind::TurnFinal
        } else {
            TranscriptEventKind::Interim
        },
        source,
        text: text.to_owned(),
        language: transcript_language(
            configured_language,
            value.get("language_code").and_then(Value::as_str),
        ),
        start_ms,
        end_ms,
        confidence,
    })
}

fn seconds_to_ms(seconds: f64) -> u64 {
    (seconds.max(0.0) * 1_000.0).round() as u64
}

pub fn prepare_frame(frame: &AudioFrame) -> Vec<f32> {
    let mono = downmix_to_mono(frame);
    resample_linear(&mono, frame.sample_rate, 16_000)
}

pub fn speaker_channel(source: AudioSource) -> SpeakerChannel {
    match source {
        AudioSource::Microphone => SpeakerChannel::SelfSpeaker,
        AudioSource::System => SpeakerChannel::Other,
    }
}

pub fn resample_linear(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if samples.is_empty() || source_rate == 0 || target_rate == 0 {
        return vec![];
    }
    if source_rate == target_rate {
        return samples.to_vec();
    }
    let output_len = samples.len().saturating_mul(target_rate as usize) / source_rate as usize;
    (0..output_len)
        .map(|index| {
            let position = index as f64 * source_rate as f64 / target_rate as f64;
            let left = position.floor() as usize;
            let right = (left + 1).min(samples.len() - 1);
            let fraction = (position - left as f64) as f32;
            samples[left] * (1.0 - fraction) + samples[right] * fraction
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepares_stereo_48khz_for_transcription() {
        let frame = AudioFrame {
            source: AudioSource::Microphone,
            samples: vec![0.5; 4_800 * 2],
            sample_rate: 48_000,
            channels: 2,
            timestamp_ms: 0,
        };
        let prepared = prepare_frame(&frame);
        assert_eq!(prepared.len(), 1_600);
        assert!(prepared.iter().all(|sample| (*sample - 0.5).abs() < 0.001));
    }

    #[test]
    fn converts_frames_to_little_endian_pcm16() {
        let frame = AudioFrame {
            source: AudioSource::Microphone,
            samples: vec![-1.0, 1.0],
            sample_rate: 16_000,
            channels: 1,
            timestamp_ms: 0,
        };
        assert_eq!(frame_to_pcm16(&frame), vec![1, 128, 255, 127]);
    }

    #[test]
    fn distinguishes_deepgram_segments_from_completed_turns() {
        let interim = r#"{"type":"Results","is_final":false,"start":0.5,"duration":1.0,"channel":{"alternatives":[{"transcript":"hello","confidence":0.9}]}}"#;
        assert_eq!(
            parse_provider_message(
                StreamingProvider::Deepgram,
                interim,
                "en",
                AudioSource::Microphone
            )
            .unwrap()
            .kind,
            TranscriptEventKind::Interim
        );
        let final_turn = interim.replace("false", "true");
        let parsed = parse_provider_message(
            StreamingProvider::Deepgram,
            &final_turn,
            "en",
            AudioSource::System,
        )
        .unwrap();
        assert_eq!(parsed.text, "hello");
        assert_eq!(parsed.kind, TranscriptEventKind::SegmentFinal);
        assert_eq!(parsed.source, AudioSource::System);
        assert_eq!((parsed.start_ms, parsed.end_ms), (500, 1_500));
    }

    #[test]
    fn parses_only_completed_assembly_ai_turns() {
        let message = r#"{"type":"Turn","transcript":"hello there","end_of_turn":true,"language_code":"en","words":[{"start":120,"end":300,"confidence":0.8},{"start":310,"end":700,"confidence":1.0}]}"#;
        let parsed = parse_provider_message(
            StreamingProvider::AssemblyAi,
            message,
            "multi",
            AudioSource::Microphone,
        )
        .unwrap();
        assert_eq!(parsed.text, "hello there");
        assert_eq!(parsed.kind, TranscriptEventKind::TurnFinal);
        assert_eq!((parsed.start_ms, parsed.end_ms), (120, 700));
        assert!((parsed.confidence - 0.9).abs() < 0.001);
    }

    #[test]
    fn uses_current_assembly_ai_streaming_contract() {
        let url = streaming_url(StreamingProvider::AssemblyAi, "u3-rt-pro", "multi");
        assert!(url.contains("speech_model=u3-rt-pro"));
        assert!(!url.contains("language_code"));
        assert!(!url.contains("prompt="));

        let forced = streaming_url(StreamingProvider::AssemblyAi, "u3-rt-pro", "es");
        assert!(forced.contains("prompt=Transcribe%20Spanish."));
    }

    #[test]
    fn sends_the_selected_conversation_language_to_deepgram() {
        let url = streaming_url(StreamingProvider::Deepgram, "nova-3", "ca");
        assert!(url.contains("language=ca"));
    }

    #[test]
    fn exact_language_overrides_provider_detection() {
        assert_eq!(transcript_language("ca", Some("es")), "ca");
        assert_eq!(transcript_language("multi", Some("es")), "es");
    }

    #[test]
    fn buffers_audio_into_fifty_millisecond_chunks() {
        let mut buffer = vec![0; STREAMING_CHUNK_BYTES - 1];
        assert!(take_streaming_chunk(&mut buffer).is_none());
        buffer.extend([1, 2]);
        assert_eq!(take_streaming_chunk(&mut buffer).unwrap().len(), 1_600);
        assert_eq!(buffer, vec![2]);
    }

    #[test]
    fn surfaces_provider_error_messages() {
        let message =
            r#"{"type":"Error","error":"Unauthorized Connection: Too many concurrent sessions"}"#;
        assert_eq!(
            parse_provider_error(message).as_deref(),
            Some("Unauthorized Connection: Too many concurrent sessions")
        );
    }

    #[test]
    fn maps_capture_sources_to_known_speakers() {
        assert_eq!(
            speaker_channel(AudioSource::Microphone),
            SpeakerChannel::SelfSpeaker
        );
        assert_eq!(speaker_channel(AudioSource::System), SpeakerChannel::Other);
    }

    #[test]
    fn assembler_combines_final_segments_until_endpoint() {
        let mut assembler = TurnAssembler::default();
        let event = |text: &str, kind| LiveTranscript {
            kind,
            source: AudioSource::System,
            text: text.into(),
            language: "ca".into(),
            start_ms: 0,
            end_ms: 100,
            confidence: 0.9,
        };
        assert!(assembler
            .push(event("bon dia", TranscriptEventKind::SegmentFinal))
            .is_none());
        let turn = assembler
            .push(event("com estàs?", TranscriptEventKind::TurnFinal))
            .expect("completed turn");
        assert_eq!(turn.text, "bon dia com estàs?");
        assert_eq!(turn.kind, TranscriptEventKind::TurnFinal);
    }

    fn transcript(source: AudioSource, text: &str, start_ms: u64, end_ms: u64) -> LiveTranscript {
        LiveTranscript {
            kind: TranscriptEventKind::TurnFinal,
            source,
            text: text.into(),
            language: "en".into(),
            start_ms,
            end_ms,
            confidence: 0.9,
        }
    }

    #[test]
    fn suppresses_microphone_echo_before_or_after_system_audio() {
        let now = Instant::now();
        let system = transcript(AudioSource::System, "I can start from my end", 3_000, 6_000);
        let microphone = transcript(
            AudioSource::Microphone,
            "I can start from my end.",
            2_000,
            5_000,
        );
        let mut reconciler = CrossStreamReconciler::new(true);
        assert!(reconciler.push(microphone.clone(), now).is_empty());
        let output = reconciler.push(system.clone(), now + Duration::from_millis(500));
        assert!(matches!(output[0], ReconciledTranscript::Emit(_)));
        assert!(matches!(output[1], ReconciledTranscript::Suppressed { .. }));

        let mut reconciler = CrossStreamReconciler::new(true);
        assert!(matches!(
            reconciler.push(system, now)[0],
            ReconciledTranscript::Emit(_)
        ));
        assert!(matches!(
            reconciler.push(microphone, now + Duration::from_millis(500))[0],
            ReconciledTranscript::Suppressed { .. }
        ));
    }

    #[test]
    fn matches_fragmented_echo_but_releases_unrelated_microphone_speech() {
        let now = Instant::now();
        let mut reconciler = CrossStreamReconciler::new(true);
        reconciler.push(
            transcript(AudioSource::System, "Bon dia, podem revisar", 1_000, 2_000),
            now,
        );
        reconciler.push(
            transcript(AudioSource::System, "la proposta avui?", 2_000, 3_000),
            now + Duration::from_millis(200),
        );
        assert!(matches!(
            reconciler.push(
                transcript(
                    AudioSource::Microphone,
                    "Bon dia podem revisar la proposta avui",
                    1_100,
                    3_100,
                ),
                now + Duration::from_millis(400),
            )[0],
            ReconciledTranscript::Suppressed { .. }
        ));

        assert!(reconciler
            .push(
                transcript(
                    AudioSource::Microphone,
                    "My local follow-up is unrelated",
                    4_000,
                    5_000,
                ),
                now + Duration::from_millis(500),
            )
            .is_empty());
        let released = reconciler.flush_due(now + Duration::from_secs(5));
        assert!(matches!(released[0], ReconciledTranscript::Emit(_)));
    }

    #[test]
    fn bypasses_hold_when_system_audio_is_unavailable() {
        let mut reconciler = CrossStreamReconciler::new(false);
        let output = reconciler.push(
            transcript(AudioSource::Microphone, "Solo micrófono", 0, 500),
            Instant::now(),
        );
        assert!(matches!(output[0], ReconciledTranscript::Emit(_)));
    }
}
