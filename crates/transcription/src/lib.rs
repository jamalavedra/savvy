use flume::Receiver;
use futures_util::{SinkExt, StreamExt};
use savvy_audio::{downmix_to_mono, AudioFrame, AudioSource};
use savvy_domain::SpeakerChannel;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::{mpsc::Sender, watch};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig, Message,
    },
};

const ASSUMED_CONFIDENCE: f32 = 0.8;
const MAX_PROVIDER_MESSAGE: usize = 65_536;
const MAX_TRANSCRIPT_BYTES: usize = 8_192;
const MAX_TRANSCRIPT_WORDS: usize = 256;
const MAX_RECONCILE_HISTORY: usize = 32;
static STREAM_EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);

fn socket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_PROVIDER_MESSAGE))
        .max_frame_size(Some(MAX_PROVIDER_MESSAGE))
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_PROVIDER_MESSAGE)
}

fn incoming_message(window: &mut (Instant, u32)) -> Result<(), TranscriptionError> {
    if window.0.elapsed() >= Duration::from_secs(1) {
        *window = (Instant::now(), 0);
    }
    window.1 += 1;
    if window.1 > 64 {
        return Err(TranscriptionError::Failed(
            "provider message rate exceeded".into(),
        ));
    }
    Ok(())
}

fn rebase_transcript(mut transcript: LiveTranscript, epoch_ms: u64) -> LiveTranscript {
    transcript.start_ms = transcript.start_ms.saturating_add(epoch_ms);
    transcript.end_ms = transcript.end_ms.saturating_add(epoch_ms);
    transcript
}

async fn deliver_transcript(
    sender: &Sender<LiveTranscript>,
    transcript: LiveTranscript,
    epoch_ms: u64,
    stop: &mut watch::Receiver<bool>,
) -> Result<bool, TranscriptionError> {
    tokio::select! {
        _ = stop.changed() => Ok(false),
        result = tokio::time::timeout(Duration::from_millis(500), sender.send(rebase_transcript(transcript, epoch_ms))) => {
            result.map_err(|_| TranscriptionError::Failed("transcript consumer stalled".into()))?
                .map_err(|_| TranscriptionError::Failed("transcript consumer closed".into()))?;
            Ok(true)
        }
    }
}

async fn write_message<S>(
    writer: &mut S,
    message: Message,
    stop: &mut watch::Receiver<bool>,
) -> Result<bool, TranscriptionError>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    tokio::select! {
        _ = stop.changed() => Ok(false),
        result = tokio::time::timeout(Duration::from_millis(500), writer.send(message)) => {
            result.map_err(|_| TranscriptionError::Failed("provider write stalled".into()))?
                .map_err(|error| TranscriptionError::Failed(format!("provider write failed: {error}")))?;
            Ok(true)
        }
    }
}

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
                    let overflow = if self.pending_microphone.len() >= MAX_RECONCILE_HISTORY {
                        self.pending_microphone
                            .pop_front()
                            .map(|item| ReconciledTranscript::Emit(item.transcript))
                    } else {
                        None
                    };
                    self.pending_microphone.push_back(TimedTranscript {
                        transcript,
                        received_at: now,
                    });
                    overflow.into_iter().collect()
                }
            }
            AudioSource::System => {
                self.recent_system.push_back(TimedTranscript {
                    transcript: transcript.clone(),
                    received_at: now,
                });
                if self.recent_system.len() > MAX_RECONCILE_HISTORY {
                    self.recent_system.pop_front();
                }
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
    if microphone_words.len() > MAX_TRANSCRIPT_WORDS * 2 {
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
        .take(MAX_TRANSCRIPT_WORDS * 4)
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
    previous[right.len()] as f32 / left.len() as f32
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

/// Drain accepted final segments before a paused/stopped consumer writes history.
/// A stopped producer gets two seconds to close; late sends then fail on the old receiver.
pub async fn assemble_transcripts(
    mut transcript_receiver: tokio::sync::mpsc::Receiver<LiveTranscript>,
    mut stop: tokio::sync::watch::Receiver<bool>,
    system_available: bool,
    mut on_final: impl FnMut(ReconciledTranscript),
    mut on_interim: impl FnMut(LiveTranscript),
    mut on_tick: impl FnMut(),
) {
    let mut assembler = TurnAssembler::default();
    let mut reconciler = CrossStreamReconciler::new(system_available);
    let mut endpoint_timer = tokio::time::interval(std::time::Duration::from_millis(100));
    let mut stop_deadline = None;
    loop {
        if *stop.borrow() && stop_deadline.is_none() {
            stop_deadline = Some(tokio::time::Instant::now() + std::time::Duration::from_secs(2));
        }
        if stop_deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
            // Stop accepting late producer events, then drain the bounded queue.
            transcript_receiver.close();
        }
        let (completed, flush_reconciler) = tokio::select! {
            event = transcript_receiver.recv() => {
                let Some(event) = event else { break };
                if event.kind == TranscriptEventKind::Interim {
                    on_interim(event);
                    (Vec::new(), false)
                } else {
                    (assembler.push(event).into_iter().collect(), false)
                }
            }
            _ = endpoint_timer.tick() => {
                (assembler.flush_expired(std::time::Duration::from_millis(900)), true)
            }
            _ = stop.changed(), if stop_deadline.is_none() => {
                stop_deadline = Some(tokio::time::Instant::now() + std::time::Duration::from_secs(2));
                continue;
            }
        };
        let now = std::time::Instant::now();
        let mut reconciled = completed
            .into_iter()
            .flat_map(|transcript| reconciler.push(transcript, now))
            .collect::<Vec<_>>();
        if flush_reconciler {
            reconciled.extend(reconciler.flush_due(now));
        }
        for transcript in reconciled {
            on_final(transcript);
        }
        if flush_reconciler && stop_deadline.is_none() {
            on_tick();
        }
    }
    for transcript in assembler.flush_expired(std::time::Duration::ZERO) {
        for reconciled in reconciler.push(transcript, std::time::Instant::now()) {
            on_final(reconciled);
        }
    }
    for transcript in reconciler.drain_pending() {
        on_final(transcript);
    }
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
                let complete = complete
                    || pending.parts.len() >= 16
                    || pending.parts.iter().map(String::len).sum::<usize>() >= MAX_TRANSCRIPT_BYTES
                    || pending
                        .parts
                        .iter()
                        .map(|part| normalized_words(part).len())
                        .sum::<usize>()
                        >= MAX_TRANSCRIPT_WORDS;
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
    stop: watch::Receiver<bool>,
    transcripts: Sender<LiveTranscript>,
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
    stream_provider_socket(
        request,
        provider,
        language,
        frames,
        stop,
        transcripts,
        source,
    )
    .await
}

async fn stream_provider_socket(
    request: tokio_tungstenite::tungstenite::http::Request<()>,
    provider: StreamingProvider,
    language: &str,
    frames: Receiver<AudioFrame>,
    mut stop: watch::Receiver<bool>,
    transcripts: Sender<LiveTranscript>,
    source: AudioSource,
) -> Result<(), TranscriptionError> {
    if *stop.borrow() {
        return Ok(());
    }
    while frames.try_recv().is_ok() {}
    let connection = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(10), connect_async_with_config(request, Some(socket_config()), false)) => result,
        _ = stop.changed() => return Ok(()),
    };
    let (socket, _) = connection
        .map_err(|_| TranscriptionError::Failed("provider connection timed out".into()))?
        .map_err(|error| {
            TranscriptionError::Failed(format!("provider connection failed: {error}"))
        })?;
    let (mut writer, mut reader) = socket.split();
    let connection_epoch = STREAM_EPOCH.elapsed().as_millis() as u64;
    let mut incoming = (Instant::now(), 0);
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
                let _ = tokio::time::timeout(Duration::from_millis(500), async {
                    writer.send(Message::Text(close.into())).await?;
                    writer.close().await
                }).await;
                return Ok(());
            }
            _ = keepalive.tick() => {
                let keepalive = match provider {
                    StreamingProvider::Deepgram => Message::Text(r#"{"type":"KeepAlive"}"#.into()),
                    StreamingProvider::AssemblyAi => Message::Ping(Vec::new().into()),
                };
                if !write_message(&mut writer, keepalive, &mut stop).await? { return Ok(()); }
            }
            frame = frames.recv_async() => {
                let frame = frame.map_err(|_| TranscriptionError::Failed("microphone stream ended".into()))?;
                let pcm = frame_to_pcm16(&frame);
                if pcm.len() > 32_000 { continue; }
                if audio_buffer.len() + pcm.len() > 32_000 { audio_buffer.clear(); }
                audio_buffer.extend(pcm);
                while let Some(chunk) = take_streaming_chunk(&mut audio_buffer) {
                    if !write_message(&mut writer, Message::Binary(chunk.into()), &mut stop).await? { return Ok(()); }
                }
            }
            message = reader.next() => {
                if message.is_some() { incoming_message(&mut incoming)?; }
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if let Some(error) = parse_provider_error(text.as_ref()) {
                            return Err(TranscriptionError::Failed(error));
                        }
                        if let Some(transcript) = parse_provider_message(provider, text.as_ref(), language, source) {
                            if !deliver_transcript(&transcripts, transcript, connection_epoch, &mut stop).await? { return Ok(()); }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if !write_message(&mut writer, Message::Pong(payload), &mut stop).await? { return Ok(()); }
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

/// Managed transcription: the same PCM stream goes to Savvy's relay instead of
/// a provider socket, and the relay forwards provider transcript JSON back
/// unchanged, so the existing parser, assembler, and reconciler are reused.
/// Returns the relay's control reason when the server ends the stream (for
/// example `quota_exhausted`), so the desktop can show the right message.
#[allow(clippy::too_many_arguments)]
pub async fn stream_managed_transcription(
    service_url: &str,
    session_id: &str,
    access_token: &str,
    language: &str,
    lease_version: u64,
    frames: Receiver<AudioFrame>,
    mut stop: watch::Receiver<bool>,
    transcripts: Sender<LiveTranscript>,
    source: AudioSource,
) -> Result<(), TranscriptionError> {
    let source_name = match source {
        AudioSource::Microphone => "microphone",
        AudioSource::System => "system",
    };
    let url = format!(
        "{}/v1/sessions/{session_id}/audio/{source_name}?language={language}&leaseVersion={lease_version}",
        service_url.trim_end_matches('/').replacen("http", "ws", 1)
    );
    let mut request = url
        .into_client_request()
        .map_err(|_| TranscriptionError::Failed("invalid Savvy service endpoint".into()))?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {access_token}"))
            .map_err(|_| TranscriptionError::Failed("invalid account credential".into()))?,
    );
    if *stop.borrow() {
        return Ok(());
    }
    while frames.try_recv().is_ok() {}
    let connection = tokio::select! {
        result=tokio::time::timeout(Duration::from_secs(10),connect_async_with_config(request, Some(socket_config()), false))=>result,
        _=stop.changed()=>return Ok(()),
    };
    let (socket, _) = connection
        .map_err(|_| TranscriptionError::Failed("Savvy service connection timed out".into()))?
        .map_err(|error| {
            if let tokio_tungstenite::tungstenite::Error::Http(response) = &error {
                if let Some(body) = response.body() {
                    if let Ok(value) = serde_json::from_slice::<Value>(body) {
                        if let Some(code) = value["code"].as_str() {
                            return TranscriptionError::Failed(code.to_owned());
                        }
                    }
                }
            }
            TranscriptionError::Failed("provider_unavailable: Savvy connection failed".into())
        })?;
    let (mut writer, mut reader) = socket.split();
    let connection_epoch = STREAM_EPOCH.elapsed().as_millis() as u64;
    let mut incoming = (Instant::now(), 0);
    let mut audio_buffer = Vec::with_capacity(STREAMING_CHUNK_BYTES * 2);

    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_ok() && !*stop.borrow() {
                    continue;
                }
                let _ = tokio::time::timeout(Duration::from_millis(500),writer.close()).await;
                return Ok(());
            }
            frame = frames.recv_async() => {
                let frame = frame.map_err(|_| TranscriptionError::Failed("capture stream ended".into()))?;
                let pcm=frame_to_pcm16(&frame);
                if pcm.len()>32_000 {continue;}
                if audio_buffer.len()+pcm.len()>32_000 {audio_buffer.clear();}
                audio_buffer.extend(pcm);
                while let Some(chunk) = take_streaming_chunk(&mut audio_buffer) {
                    tokio::select! {
                        result=tokio::time::timeout(Duration::from_millis(500),writer.send(Message::Binary(chunk.into())))=>{
                            if !matches!(result,Ok(Ok(()))) {return Err(TranscriptionError::Failed("provider_unavailable: audio write stalled".into()));}
                        }
                        _=stop.changed()=>return Ok(()),
                    }
                }
            }
            message = reader.next() => {
                if message.is_some() { incoming_message(&mut incoming)?; }
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if let Some(reason) = parse_control_message(text.as_ref()) {
                            let _ = tokio::time::timeout(Duration::from_millis(500),writer.close()).await;
                            return Err(TranscriptionError::Failed(reason));
                        }
                        if let Some(error) = parse_provider_error(text.as_ref()) {
                            return Err(TranscriptionError::Failed(error));
                        }
                        if let Some(transcript) = parse_provider_message(
                            StreamingProvider::Deepgram, text.as_ref(), language, source
                        ) {
                            if !deliver_transcript(&transcripts, transcript, connection_epoch, &mut stop).await? { return Ok(()); }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if !matches!(tokio::time::timeout(Duration::from_millis(500),writer.send(Message::Pong(payload))).await,Ok(Ok(()))) {return Err(TranscriptionError::Failed("provider_unavailable: socket stalled".into()));}
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        return Err(TranscriptionError::Failed(
                            "Savvy service closed the transcription stream".into(),
                        ));
                    }
                    Some(Err(error)) => {
                        return Err(TranscriptionError::Failed(
                            format!("Savvy service receive failed: {error}"),
                        ));
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Relay control frames carry a typed reason such as `quota_exhausted`.
fn parse_control_message(message: &str) -> Option<String> {
    let value: Value = serde_json::from_str(message).ok()?;
    (value.get("type").and_then(Value::as_str) == Some("SavvyControl")).then(|| {
        value
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("provider_unavailable")
            .to_owned()
    })
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
    if message.len() > MAX_PROVIDER_MESSAGE {
        return None;
    }
    let value: Value = serde_json::from_str(message).ok()?;
    let transcript = match provider {
        StreamingProvider::Deepgram => parse_deepgram(value, configured_language, source),
        StreamingProvider::AssemblyAi => parse_assembly_ai(value, configured_language, source),
    }?;
    (transcript.text.len() <= MAX_TRANSCRIPT_BYTES
        && transcript.language.len() <= 32
        && transcript.end_ms >= transcript.start_ms
        && transcript.end_ms - transcript.start_ms <= 300_000
        && normalized_words(&transcript.text).len() <= MAX_TRANSCRIPT_WORDS)
        .then_some(transcript)
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
        end_ms: start_ms.checked_add(duration_ms)?,
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
    if words.is_some_and(|words| words.len() > MAX_TRANSCRIPT_WORDS) {
        return None;
    }
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
    // AssemblyAI omits per-word confidence on some turns. Treat that as typical
    // rather than zero, so downstream grounding scores do not reject the advice.
    let confidence = words
        .map(|words| {
            let values = words
                .iter()
                .filter_map(|word| word.get("confidence").and_then(Value::as_f64))
                .collect::<Vec<_>>();
            if values.is_empty() {
                ASSUMED_CONFIDENCE
            } else {
                (values.iter().sum::<f64>() / values.len() as f64) as f32
            }
        })
        .unwrap_or(ASSUMED_CONFIDENCE);
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

    #[tokio::test]
    async fn both_transports_stop_during_stalled_handshakes_and_writes() {
        for (managed, handshake) in [(false, false), (false, true), (true, false), (true, true)] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                if handshake {
                    let socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                    let _ = ready_tx.send(());
                    std::future::pending::<()>().await;
                    drop(socket);
                } else {
                    let _ = ready_tx.send(());
                    std::future::pending::<()>().await;
                    drop(stream);
                }
            });
            let (frames_tx, frames_rx) = flume::bounded(2);
            let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
            let (transcripts, _) = tokio::sync::mpsc::channel(64);
            let task = tokio::spawn(async move {
                if !managed {
                    return super::stream_provider_socket(
                        format!("ws://{address}").into_client_request().unwrap(),
                        super::StreamingProvider::Deepgram,
                        "en",
                        frames_rx,
                        stop_rx,
                        transcripts,
                        super::AudioSource::Microphone,
                    )
                    .await;
                }
                super::stream_managed_transcription(
                    &format!("http://{address}"),
                    "00000000-0000-4000-8000-000000000001",
                    "synthetic-access-token",
                    "en",
                    1,
                    frames_rx,
                    stop_rx,
                    transcripts,
                    super::AudioSource::Microphone,
                )
                .await
            });
            ready_rx.await.unwrap();
            let producer = tokio::spawn(async move {
                loop {
                    if frames_tx
                        .send_async(super::AudioFrame {
                            source: super::AudioSource::Microphone,
                            samples: vec![0.0; 16000],
                            sample_rate: 16000,
                            channels: 1,
                            timestamp_ms: 0,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let start = std::time::Instant::now();
            stop_tx.send(true).unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .expect("stop must not wait for a blocked socket")
                .unwrap()
                .unwrap();
            assert!(start.elapsed() < std::time::Duration::from_secs(1));
            producer.abort();
            server.abort();
        }
    }
    use super::*;

    #[tokio::test]
    async fn bounded_transcript_delivery_remains_cancellable() {
        let (sender, _receiver) = tokio::sync::mpsc::channel(1);
        let item = transcript(AudioSource::Microphone, "speech", 0, 100);
        sender.send(item.clone()).await.unwrap();
        let (stop, mut receiver) = watch::channel(false);
        let task =
            tokio::spawn(async move { deliver_transcript(&sender, item, 0, &mut receiver).await });
        stop.send(true).unwrap();
        assert!(!tokio::time::timeout(Duration::from_millis(100), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap());
    }

    #[tokio::test]
    async fn provider_sockets_reject_oversized_messages_and_message_floods() {
        for flood in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                for _ in 0..if flood { 65 } else { 1 } {
                    let payload = if flood {
                        "{}".to_owned()
                    } else {
                        "x".repeat(MAX_PROVIDER_MESSAGE + 1)
                    };
                    if socket.send(Message::Text(payload.into())).await.is_err() {
                        break;
                    }
                }
                std::future::pending::<()>().await;
                drop(socket);
            });
            let (_frames, receiver) = flume::bounded(1);
            let (_stop, stop) = watch::channel(false);
            let (transcripts, mut output) = tokio::sync::mpsc::channel(1);
            let result = tokio::time::timeout(
                Duration::from_secs(2),
                stream_provider_socket(
                    format!("ws://{address}").into_client_request().unwrap(),
                    StreamingProvider::Deepgram,
                    "en",
                    receiver,
                    stop,
                    transcripts,
                    AudioSource::Microphone,
                ),
            )
            .await;
            server.abort();
            assert!(result
                .expect("hostile input must close the stream")
                .is_err());
            assert!(output.try_recv().is_err());
        }
    }

    #[test]
    fn rejects_oversized_supplier_fields_and_bounds_event_and_turn_work() {
        let message = |text: &str| {
            serde_json::json!({"type":"Turn", "transcript":text, "end_of_turn":true}).to_string()
        };
        for text in [
            "a".repeat(MAX_TRANSCRIPT_BYTES + 1),
            "word ".repeat(MAX_TRANSCRIPT_WORDS + 1),
        ] {
            assert!(parse_provider_message(
                StreamingProvider::AssemblyAi,
                &message(&text),
                "en",
                AudioSource::Microphone
            )
            .is_none());
        }
        assert!(parse_provider_message(StreamingProvider::Deepgram,
            r#"{"type":"Results","start":1e100,"duration":1e100,"channel":{"alternatives":[{"transcript":"test"}]}}"#,
            "en", AudioSource::Microphone).is_none());
        let mut window = (Instant::now(), 0);
        for _ in 0..64 {
            incoming_message(&mut window).unwrap();
        }
        assert!(incoming_message(&mut window).is_err());
        let mut assembler = TurnAssembler::default();
        let mut emitted = 0;
        for i in 0..160 {
            let mut item = transcript(AudioSource::Microphone, &format!("segment {i}"), i, i + 1);
            item.kind = TranscriptEventKind::SegmentFinal;
            emitted += usize::from(assembler.push(item).is_some());
            assert!(assembler
                .microphone
                .as_ref()
                .is_none_or(|p| p.parts.len() < 16));
        }
        assert_eq!(emitted, 10);
        let now = Instant::now();
        let mut reconciler = CrossStreamReconciler::new(true);
        for i in 0..100 {
            reconciler.push(
                transcript(AudioSource::System, &format!("remote word {i}"), 0, 100),
                now,
            );
            reconciler.push(
                transcript(
                    AudioSource::Microphone,
                    &format!("local question {i}"),
                    0,
                    100,
                ),
                now,
            );
        }
        assert_eq!(reconciler.recent_system.len(), MAX_RECONCILE_HISTORY);
        assert_eq!(reconciler.pending_microphone.len(), MAX_RECONCILE_HISTORY);
    }

    #[test]
    fn a_single_reconnected_stream_shares_the_existing_echo_timeline() {
        let now = Instant::now();
        let mut reconciler = CrossStreamReconciler::new(true);
        reconciler.push(
            rebase_transcript(
                transcript(
                    AudioSource::System,
                    "the same spoken phrase",
                    100_000,
                    101_000,
                ),
                0,
            ),
            now,
        );
        let restarted = rebase_transcript(
            transcript(AudioSource::Microphone, "the same spoken phrase", 0, 1000),
            100_000,
        );
        assert!(matches!(
            reconciler.push(restarted, now)[0],
            ReconciledTranscript::Suppressed { .. }
        ));
    }

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
    fn surfaces_relay_control_reasons() {
        assert_eq!(
            parse_control_message(r#"{"type":"SavvyControl","reason":"quota_exhausted"}"#)
                .as_deref(),
            Some("quota_exhausted")
        );
        assert_eq!(
            parse_control_message(r#"{"type":"Results","is_final":true}"#),
            None
        );
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

    #[tokio::test]
    async fn assembly_drains_both_tails_before_return_and_rejects_late_events() {
        for keep_producer_open in [false, true] {
            let (sender, receiver) = tokio::sync::mpsc::channel(64);
            let (stop_sender, stop) = tokio::sync::watch::channel(false);
            for (source, text) in [
                (AudioSource::Microphone, "My final local sentence"),
                (AudioSource::System, "Their separate remote proposal"),
            ] {
                let mut event = transcript(source, text, 100, 200);
                event.kind = TranscriptEventKind::SegmentFinal;
                sender.send(event).await.unwrap();
            }
            let sender = if keep_producer_open {
                stop_sender.send(true).unwrap();
                Some(sender)
            } else {
                drop(sender);
                None
            };
            let mut saved = Vec::new();
            tokio::time::timeout(
                Duration::from_secs(4),
                assemble_transcripts(
                    receiver,
                    stop,
                    true,
                    |event| {
                        if let ReconciledTranscript::Emit(turn) = event {
                            saved.push(turn.text);
                        }
                    },
                    |_| panic!("final segments must not become interim events"),
                    || {},
                ),
            )
            .await
            .expect("assembly shutdown is bounded");
            saved.sort();
            assert_eq!(
                saved,
                ["My final local sentence", "Their separate remote proposal"]
            );
            if let Some(sender) = sender {
                assert!(sender
                    .send(transcript(
                        AudioSource::Microphone,
                        "late old stream",
                        200,
                        300
                    ))
                    .await
                    .is_err());
            }
        }
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

    #[test]
    fn preserves_microphone_speech_containing_a_short_system_phrase() {
        let now = Instant::now();
        let mut reconciler = CrossStreamReconciler::new(true);
        reconciler.push(transcript(AudioSource::System, "yes proceed", 0, 1000), now);
        let microphone = transcript(
            AudioSource::Microphone,
            "yes we should not proceed",
            0,
            1000,
        );
        assert!(reconciler.push(microphone.clone(), now).is_empty());
        assert_eq!(
            reconciler.flush_due(now + MICROPHONE_FINAL_HOLD),
            vec![ReconciledTranscript::Emit(microphone)]
        );
    }
}
