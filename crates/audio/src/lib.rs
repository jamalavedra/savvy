use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use flume::{Receiver, Sender};
use hound::{WavReader, WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::{
    f32::consts::TAU,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
    thread,
    thread::JoinHandle,
    time::Duration,
    time::Instant,
};
use thiserror::Error;

#[cfg(target_os = "macos")]
use screencapturekit::prelude::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AudioSource {
    Microphone,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioFrame {
    pub source: AudioSource,
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub name: String,
    pub is_default: bool,
    pub channels: u16,
}

#[derive(Debug, Error)]
pub enum AudioError {
    #[error("capture permission is missing for {0}")]
    PermissionMissing(&'static str),
    #[error("audio device is unavailable: {0}")]
    DeviceUnavailable(String),
    #[error("capture failed: {0}")]
    Capture(String),
}

pub trait AudioCapture: Send {
    fn start(&mut self) -> Result<(), AudioError>;
    fn pause(&mut self) -> Result<(), AudioError>;
    fn resume(&mut self) -> Result<(), AudioError>;
    fn stop(&mut self) -> Result<(), AudioError>;
    fn is_running(&self) -> bool;
}

pub struct MicrophoneCapture {
    stream: Option<cpal::Stream>,
    selected_device: Option<String>,
    selected_channel: Option<u16>,
    sender: Sender<AudioFrame>,
    receiver: Receiver<AudioFrame>,
    last_error: Arc<Mutex<Option<String>>>,
    level: Arc<AtomicU32>,
    recording_path: Option<PathBuf>,
    recording_sender: Option<Sender<AudioFrame>>,
    recording_thread: Option<JoinHandle<Result<(), AudioError>>>,
}

#[cfg(target_os = "macos")]
pub struct SystemAudioCapture {
    stream: Option<SCStream>,
    sender: Sender<AudioFrame>,
    receiver: Receiver<AudioFrame>,
}

#[cfg(target_os = "macos")]
impl Default for SystemAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "macos")]
impl SystemAudioCapture {
    pub fn new() -> Self {
        let (sender, receiver) = flume::bounded(64);
        Self {
            stream: None,
            sender,
            receiver,
        }
    }

    pub fn frames(&self) -> Receiver<AudioFrame> {
        self.receiver.clone()
    }
}

impl Default for MicrophoneCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl MicrophoneCapture {
    pub fn new() -> Self {
        let (sender, receiver) = flume::bounded(64);
        Self {
            stream: None,
            selected_device: None,
            selected_channel: None,
            sender,
            receiver,
            last_error: Arc::new(Mutex::new(None)),
            level: Arc::new(AtomicU32::new(0)),
            recording_path: None,
            recording_sender: None,
            recording_thread: None,
        }
    }

    pub fn frames(&self) -> Receiver<AudioFrame> {
        self.receiver.clone()
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|value| value.clone())
    }

    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }

    pub fn configure(
        &mut self,
        selected_device: Option<String>,
        selected_channel: Option<u16>,
    ) -> Result<(), AudioError> {
        if self.stream.is_some() {
            return Err(AudioError::Capture(
                "stop listening before changing the microphone".into(),
            ));
        }
        self.selected_device = selected_device;
        self.selected_channel = selected_channel;
        Ok(())
    }

    pub fn record_to(&mut self, path: PathBuf) -> Result<(), AudioError> {
        if self.stream.is_some() {
            return Err(AudioError::Capture(
                "stop listening before changing the recording path".into(),
            ));
        }
        self.recording_path = Some(path);
        Ok(())
    }

    fn build_stream(
        &self,
        recording_sender: Option<Sender<AudioFrame>>,
    ) -> Result<cpal::Stream, AudioError> {
        let host = cpal::default_host();
        let device = find_device(&host, self.selected_device.as_deref(), true)?;
        let supported = device
            .default_input_config()
            .map_err(|error| AudioError::DeviceUnavailable(error.to_string()))?;
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let sample_rate = config.sample_rate;
        let channels = config.channels;
        let started = Instant::now();
        let sender = self.sender.clone();
        let errors = self.last_error.clone();
        let level = self.level.clone();
        let selected_channel = self.selected_channel;

        let stream = match sample_format {
            cpal::SampleFormat::F32 => {
                let recording_sender = recording_sender.clone();
                device.build_input_stream(
                    &config,
                    move |data: &[f32], _| {
                        send_input_frame(
                            (&sender, recording_sender.as_ref()),
                            data.to_vec(),
                            sample_rate,
                            channels,
                            selected_channel,
                            started,
                            &level,
                        )
                    },
                    capture_error(errors),
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let recording_sender = recording_sender.clone();
                device.build_input_stream(
                    &config,
                    move |data: &[i16], _| {
                        let samples = data
                            .iter()
                            .map(|sample| f32::from(*sample) / f32::from(i16::MAX))
                            .collect();
                        send_input_frame(
                            (&sender, recording_sender.as_ref()),
                            samples,
                            sample_rate,
                            channels,
                            selected_channel,
                            started,
                            &level,
                        );
                    },
                    capture_error(errors),
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                let recording_sender = recording_sender.clone();
                device.build_input_stream(
                    &config,
                    move |data: &[u16], _| {
                        let samples = data
                            .iter()
                            .map(|sample| (f32::from(*sample) / f32::from(u16::MAX)) * 2.0 - 1.0)
                            .collect();
                        send_input_frame(
                            (&sender, recording_sender.as_ref()),
                            samples,
                            sample_rate,
                            channels,
                            selected_channel,
                            started,
                            &level,
                        );
                    },
                    capture_error(errors),
                    None,
                )
            }
            format => {
                return Err(AudioError::DeviceUnavailable(format!(
                    "unsupported microphone sample format: {format:?}"
                )))
            }
        }
        .map_err(|error| AudioError::Capture(error.to_string()))?;
        Ok(stream)
    }
}

pub fn input_devices() -> Result<Vec<AudioDevice>, AudioError> {
    list_devices(true)
}

pub fn output_devices() -> Result<Vec<AudioDevice>, AudioError> {
    list_devices(false)
}

pub fn play_feedback(device_name: Option<String>, volume: f32, started: bool) {
    thread::spawn(move || {
        let _ = play_tone(
            device_name.as_deref(),
            volume.clamp(0.0, 1.0),
            if started { 660.0 } else { 440.0 },
        );
    });
}

fn play_tone(device_name: Option<&str>, volume: f32, frequency: f32) -> Result<(), AudioError> {
    let host = cpal::default_host();
    let device = find_device(&host, device_name, false)?;
    let supported = device
        .default_output_config()
        .map_err(|error| AudioError::DeviceUnavailable(error.to_string()))?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let sample_rate = config.sample_rate as f32;
    let channels = usize::from(config.channels);
    let frames = (sample_rate * 0.09) as usize;
    let error = |error| eprintln!("Savvy audio feedback failed: {error}");

    let stream = match format {
        cpal::SampleFormat::F32 => {
            let mut cursor = 0;
            device.build_output_stream(
                &config,
                move |data: &mut [f32], _| {
                    write_tone(
                        data,
                        channels,
                        &mut cursor,
                        frames,
                        sample_rate,
                        frequency,
                        volume,
                    )
                },
                error,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let mut cursor = 0;
            device.build_output_stream(
                &config,
                move |data: &mut [i16], _| {
                    let mut buffer = vec![0.0; data.len()];
                    write_tone(
                        &mut buffer,
                        channels,
                        &mut cursor,
                        frames,
                        sample_rate,
                        frequency,
                        volume,
                    );
                    data.iter_mut().zip(buffer).for_each(|(output, sample)| {
                        *output = (sample * f32::from(i16::MAX)) as i16
                    });
                },
                error,
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let mut cursor = 0;
            device.build_output_stream(
                &config,
                move |data: &mut [u16], _| {
                    let mut buffer = vec![0.0; data.len()];
                    write_tone(
                        &mut buffer,
                        channels,
                        &mut cursor,
                        frames,
                        sample_rate,
                        frequency,
                        volume,
                    );
                    data.iter_mut().zip(buffer).for_each(|(output, sample)| {
                        *output = ((sample * 0.5 + 0.5) * f32::from(u16::MAX)) as u16
                    });
                },
                error,
                None,
            )
        }
        format => {
            return Err(AudioError::DeviceUnavailable(format!(
                "unsupported output sample format: {format:?}"
            )))
        }
    }
    .map_err(|error| AudioError::Capture(error.to_string()))?;
    stream
        .play()
        .map_err(|error| AudioError::Capture(error.to_string()))?;
    thread::sleep(Duration::from_millis(120));
    Ok(())
}

fn write_tone(
    data: &mut [f32],
    channels: usize,
    cursor: &mut usize,
    frames: usize,
    sample_rate: f32,
    frequency: f32,
    volume: f32,
) {
    for frame in data.chunks_mut(channels) {
        let progress = *cursor as f32 / frames as f32;
        let envelope = (progress * 10.0).min(1.0) * ((1.0 - progress) * 10.0).clamp(0.0, 1.0);
        let sample = if *cursor < frames {
            (TAU * frequency * *cursor as f32 / sample_rate).sin() * volume * 0.2 * envelope
        } else {
            0.0
        };
        frame.fill(sample);
        *cursor += 1;
    }
}

fn list_devices(input: bool) -> Result<Vec<AudioDevice>, AudioError> {
    let host = cpal::default_host();
    let default = if input {
        host.default_input_device()
    } else {
        host.default_output_device()
    };
    let default_channels = default
        .as_ref()
        .and_then(|device| {
            if input {
                device.default_input_config().ok()
            } else {
                device.default_output_config().ok()
            }
        })
        .map_or(1, |config| config.channels());
    let mut result = vec![AudioDevice {
        name: "System default".into(),
        is_default: true,
        channels: default_channels,
    }];
    let devices = if input {
        host.input_devices()
    } else {
        host.output_devices()
    }
    .map_err(|error| AudioError::DeviceUnavailable(error.to_string()))?;
    for device in devices {
        let name = device
            .description()
            .map_err(|error| AudioError::DeviceUnavailable(error.to_string()))?
            .name()
            .to_owned();
        let channels = if input {
            device.default_input_config().ok()
        } else {
            device.default_output_config().ok()
        }
        .map_or(1, |config| config.channels());
        result.push(AudioDevice {
            name,
            is_default: false,
            channels,
        });
    }
    Ok(result)
}

fn find_device(
    host: &cpal::Host,
    selected: Option<&str>,
    input: bool,
) -> Result<cpal::Device, AudioError> {
    if let Some(selected) = selected {
        let devices = if input {
            host.input_devices()
        } else {
            host.output_devices()
        }
        .map_err(|error| AudioError::DeviceUnavailable(error.to_string()))?;
        return devices
            .filter_map(|device| {
                device
                    .description()
                    .ok()
                    .map(|description| (description.name().to_owned(), device))
            })
            .find(|(name, _)| name == selected)
            .map(|(_, device)| device)
            .ok_or_else(|| AudioError::DeviceUnavailable(selected.into()));
    }
    (if input {
        host.default_input_device()
    } else {
        host.default_output_device()
    })
    .ok_or_else(|| AudioError::DeviceUnavailable("no system default device is configured".into()))
}

fn send_input_frame(
    senders: (&Sender<AudioFrame>, Option<&Sender<AudioFrame>>),
    samples: Vec<f32>,
    sample_rate: u32,
    channels: u16,
    selected_channel: Option<u16>,
    started: Instant,
    level: &AtomicU32,
) {
    let (samples, channels) = select_channel(samples, channels, selected_channel);
    level.store(rms_level(&samples).to_bits(), Ordering::Relaxed);
    let frame = AudioFrame {
        source: AudioSource::Microphone,
        samples,
        sample_rate,
        channels,
        timestamp_ms: started.elapsed().as_millis() as u64,
    };
    if let Some(recording_sender) = senders.1 {
        let _ = recording_sender.try_send(frame.clone());
    }
    let _ = senders.0.try_send(frame);
}

fn rms_level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
}

fn select_channel(
    samples: Vec<f32>,
    channels: u16,
    selected_channel: Option<u16>,
) -> (Vec<f32>, u16) {
    let Some(channel) = selected_channel.filter(|channel| *channel < channels) else {
        return (samples, channels);
    };
    (
        samples
            .chunks(usize::from(channels))
            .filter_map(|frame| frame.get(usize::from(channel)).copied())
            .collect(),
        1,
    )
}

impl AudioCapture for MicrophoneCapture {
    fn start(&mut self) -> Result<(), AudioError> {
        if self.stream.is_some() {
            return Ok(());
        }
        if let Ok(mut error) = self.last_error.lock() {
            *error = None;
        }
        let recording = self.recording_path.clone().map(|path| {
            let (sender, receiver) = flume::unbounded();
            (path, sender, receiver)
        });
        let recording_sender = recording.as_ref().map(|(_, sender, _)| sender.clone());
        let stream = self.build_stream(recording_sender.clone())?;
        let recording_thread = recording
            .map(|(path, _, receiver)| thread::spawn(move || write_recording(&path, receiver)));
        if let Err(error) = stream.play() {
            drop(stream);
            drop(recording_sender);
            if let Some(handle) = recording_thread {
                let _ = handle.join();
            }
            return Err(AudioError::Capture(error.to_string()));
        }
        self.stream = Some(stream);
        self.recording_sender = recording_sender;
        self.recording_thread = recording_thread;
        Ok(())
    }

    fn pause(&mut self) -> Result<(), AudioError> {
        self.stream
            .as_ref()
            .ok_or_else(|| AudioError::Capture("microphone is not running".into()))?
            .pause()
            .map_err(|error| AudioError::Capture(error.to_string()))?;
        self.level.store(0, Ordering::Relaxed);
        Ok(())
    }

    fn resume(&mut self) -> Result<(), AudioError> {
        self.stream
            .as_ref()
            .ok_or_else(|| AudioError::Capture("microphone is not running".into()))?
            .play()
            .map_err(|error| AudioError::Capture(error.to_string()))
    }

    fn stop(&mut self) -> Result<(), AudioError> {
        let pause_error = self
            .stream
            .take()
            .and_then(|stream| stream.pause().err())
            .map(|error| AudioError::Capture(error.to_string()));
        drop(self.recording_sender.take());
        let write_result = if let Some(handle) = self.recording_thread.take() {
            handle
                .join()
                .map_err(|_| AudioError::Capture("recording writer stopped unexpectedly".into()))?
        } else {
            Ok(())
        };
        self.recording_path = None;
        self.level.store(0, Ordering::Relaxed);
        write_result?;
        pause_error.map_or(Ok(()), Err)
    }

    fn is_running(&self) -> bool {
        self.stream.is_some()
    }
}

#[cfg(target_os = "macos")]
impl AudioCapture for SystemAudioCapture {
    fn start(&mut self) -> Result<(), AudioError> {
        if self.stream.is_some() {
            return Ok(());
        }
        let content =
            SCShareableContent::get().map_err(|error| AudioError::Capture(error.to_string()))?;
        let display = content
            .displays()
            .into_iter()
            .next()
            .ok_or_else(|| AudioError::DeviceUnavailable("no display is available".into()))?;
        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&[])
            .build();
        let configuration = SCStreamConfiguration::new()
            .with_captures_audio(true)
            .with_excludes_current_process_audio(true)
            .with_sample_rate(48_000)
            .with_channel_count(1);
        let sender = self.sender.clone();
        let started = Instant::now();
        let mut stream = SCStream::new(&filter, &configuration);
        stream.add_output_handler(
            move |sample: CMSampleBuffer, output_type: SCStreamOutputType| {
                if output_type != SCStreamOutputType::Audio {
                    return;
                }
                let Some(buffers) = sample.audio_buffer_list() else {
                    return;
                };
                for buffer in &buffers {
                    let samples = buffer
                        .data()
                        .chunks_exact(std::mem::size_of::<f32>())
                        .map(|bytes| f32::from_le_bytes(bytes.try_into().expect("four-byte chunk")))
                        .collect::<Vec<_>>();
                    if samples.is_empty() {
                        continue;
                    }
                    let _ = sender.try_send(AudioFrame {
                        source: AudioSource::System,
                        samples,
                        sample_rate: 48_000,
                        channels: buffer.number_channels.max(1) as u16,
                        timestamp_ms: started.elapsed().as_millis() as u64,
                    });
                }
            },
            SCStreamOutputType::Audio,
        );
        stream
            .start_capture()
            .map_err(|error| AudioError::Capture(error.to_string()))?;
        self.stream = Some(stream);
        Ok(())
    }

    fn pause(&mut self) -> Result<(), AudioError> {
        self.stream
            .as_mut()
            .ok_or_else(|| AudioError::Capture("system audio is not running".into()))?
            .stop_capture()
            .map_err(|error| AudioError::Capture(error.to_string()))
    }

    fn resume(&mut self) -> Result<(), AudioError> {
        self.stream
            .as_mut()
            .ok_or_else(|| AudioError::Capture("system audio is not running".into()))?
            .start_capture()
            .map_err(|error| AudioError::Capture(error.to_string()))
    }

    fn stop(&mut self) -> Result<(), AudioError> {
        let Some(stream) = self.stream.take() else {
            return Ok(());
        };
        stream
            .stop_capture()
            .map_err(|error| AudioError::Capture(error.to_string()))
    }

    fn is_running(&self) -> bool {
        self.stream.is_some()
    }
}

fn write_recording(path: &Path, receiver: Receiver<AudioFrame>) -> Result<(), AudioError> {
    let first = receiver
        .recv()
        .map_err(|_| AudioError::Capture("recording contained no audio".into()))?;
    let parent = path
        .parent()
        .ok_or_else(|| AudioError::Capture("recording directory is unavailable".into()))?;
    fs::create_dir_all(parent).map_err(|error| AudioError::Capture(error.to_string()))?;
    let temporary = path.with_extension("wav.part");
    let spec = WavSpec {
        channels: first.channels,
        sample_rate: first.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = WavWriter::create(&temporary, spec)
        .map_err(|error| AudioError::Capture(error.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| AudioError::Capture(error.to_string()))?;
    }
    let mut sample_count = 0usize;
    write_recording_frame(&mut writer, &first, spec, &mut sample_count)?;
    for frame in receiver {
        write_recording_frame(&mut writer, &frame, spec, &mut sample_count)?;
    }
    writer
        .finalize()
        .map_err(|error| AudioError::Capture(error.to_string()))?;
    let actual = WavReader::open(&temporary)
        .map_err(|error| AudioError::Capture(error.to_string()))?
        .len() as usize;
    if actual != sample_count {
        return Err(AudioError::Capture(format!(
            "recording verification failed: expected {sample_count} samples, found {actual}"
        )));
    }
    fs::rename(temporary, path).map_err(|error| AudioError::Capture(error.to_string()))?;
    Ok(())
}

fn write_recording_frame(
    writer: &mut WavWriter<std::io::BufWriter<fs::File>>,
    frame: &AudioFrame,
    spec: WavSpec,
    sample_count: &mut usize,
) -> Result<(), AudioError> {
    if frame.sample_rate != spec.sample_rate || frame.channels != spec.channels {
        return Err(AudioError::Capture(
            "microphone format changed during recording".into(),
        ));
    }
    for sample in &frame.samples {
        writer
            .write_sample((sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16)
            .map_err(|error| AudioError::Capture(error.to_string()))?;
    }
    *sample_count += frame.samples.len();
    Ok(())
}

fn capture_error(
    destination: Arc<Mutex<Option<String>>>,
) -> impl FnMut(cpal::StreamError) + Send + 'static {
    move |error| {
        if let Ok(mut value) = destination.lock() {
            *value = Some(error.to_string());
        }
    }
}

pub fn downmix_to_mono(frame: &AudioFrame) -> Vec<f32> {
    let channels = usize::from(frame.channels.max(1));
    if channels == 1 {
        return frame.samples.clone();
    }

    frame
        .samples
        .chunks(channels)
        .map(|sample| sample.iter().copied().sum::<f32>() / channels as f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_frames_are_downmixed_without_crossing_frames() {
        let frame = AudioFrame {
            source: AudioSource::System,
            samples: vec![1.0, 0.0, 0.5, -0.5],
            sample_rate: 48_000,
            channels: 2,
            timestamp_ms: 0,
        };
        assert_eq!(downmix_to_mono(&frame), vec![0.5, 0.0]);
    }

    #[test]
    fn selected_microphone_channel_is_extracted() {
        assert_eq!(
            select_channel(vec![1.0, 2.0, 3.0, 4.0], 2, Some(1)),
            (vec![2.0, 4.0], 1)
        );
    }

    #[test]
    fn microphone_level_is_rms() {
        assert_eq!(rms_level(&[1.0, -1.0]), 1.0);
        assert_eq!(rms_level(&[]), 0.0);
    }

    #[test]
    fn recording_is_verified_before_the_final_wav_is_published() {
        let path = std::env::temp_dir().join(format!(
            "savvy-audio-test-{}-{}.wav",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let (sender, receiver) = flume::unbounded();
        sender
            .send(AudioFrame {
                source: AudioSource::Microphone,
                samples: vec![0.0, 0.5, -0.5],
                sample_rate: 16_000,
                channels: 1,
                timestamp_ms: 0,
            })
            .expect("send frame");
        drop(sender);

        write_recording(&path, receiver).expect("write recording");
        let reader = WavReader::open(&path).expect("read recording");
        assert_eq!(reader.spec().sample_rate, 16_000);
        assert_eq!(reader.len(), 3);
        assert!(!path.with_extension("wav.part").exists());
        fs::remove_file(path).expect("remove recording");
    }
}
