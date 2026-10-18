use super::*;
use std::sync::atomic::{AtomicBool, AtomicU64};

pub struct SystemAudioCapture {
    stream: Option<cpal::Stream>,
    silence_stop: Option<Arc<AtomicBool>>,
    silence_thread: Option<JoinHandle<()>>,
    selected_device: Option<String>,
    sender: Sender<AudioFrame>,
    receiver: Receiver<AudioFrame>,
    last_error: Arc<Mutex<Option<String>>>,
    level: Arc<AtomicU32>,
    last_data_ms: Arc<AtomicU64>,
}

impl Default for SystemAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemAudioCapture {
    pub fn new() -> Self {
        let (sender, receiver) = flume::bounded(64);
        Self {
            stream: None,
            silence_stop: None,
            silence_thread: None,
            selected_device: None,
            sender,
            receiver,
            last_error: Arc::new(Mutex::new(None)),
            level: Arc::new(AtomicU32::new(0)),
            last_data_ms: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn level(&self) -> Result<f32, AudioError> {
        if let Some(error) = self
            .last_error
            .lock()
            .map_err(|_| AudioError::Capture("system audio error lock poisoned".into()))?
            .as_ref()
        {
            return Err(AudioError::Capture(format!(
                "System audio capture stopped: {error}"
            )));
        }
        Ok(f32::from_bits(self.level.load(Ordering::Relaxed)))
    }

    pub fn configure(&mut self, selected_device: Option<String>) -> Result<(), AudioError> {
        if self.stream.is_some() {
            return Err(AudioError::Capture(
                "stop the meeting before changing system audio output".into(),
            ));
        }
        self.selected_device = selected_device;
        Ok(())
    }

    pub fn frames(&self) -> Receiver<AudioFrame> {
        self.receiver.clone()
    }

    pub fn take_error(&self) -> Option<String> {
        self.last_error.lock().ok()?.take()
    }

    fn build_stream<T>(
        &self,
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        started: Instant,
    ) -> Result<cpal::Stream, AudioError>
    where
        T: cpal::SizedSample,
        f32: cpal::FromSample<T>,
    {
        let sender = self.sender.clone();
        let sample_rate = config.sample_rate;
        let channels = config.channels;
        let level = self.level.clone();
        let last_data_ms = self.last_data_ms.clone();
        // CPAL enables WASAPI loopback when an output device is opened for input.
        device
            .build_input_stream(
                config,
                move |data: &[T], _| {
                    if data.is_empty() {
                        return;
                    }
                    let frame = loopback_frame(
                        data,
                        sample_rate,
                        channels,
                        started.elapsed().as_millis() as u64,
                    );
                    level.store(rms_level(&frame.samples).to_bits(), Ordering::Relaxed);
                    last_data_ms.store(frame.timestamp_ms, Ordering::Relaxed);
                    let _ = sender.try_send(frame);
                },
                capture_error(self.last_error.clone()),
                None,
            )
            .map_err(|error| AudioError::Capture(error.to_string()))
    }
}

fn send_idle_silence(
    sender: &Sender<AudioFrame>,
    sample_rate: u32,
    channels: u16,
    now_ms: u64,
    last_data_ms: u64,
) -> bool {
    if now_ms.saturating_sub(last_data_ms) < 100 {
        return false;
    }
    sender
        .try_send(AudioFrame {
            source: AudioSource::System,
            samples: vec![0.0; sample_rate as usize * channels as usize / 20],
            sample_rate,
            channels,
            timestamp_ms: now_ms,
        })
        .is_ok()
}

fn loopback_frame<T: cpal::Sample>(
    data: &[T],
    sample_rate: u32,
    channels: u16,
    timestamp_ms: u64,
) -> AudioFrame
where
    f32: cpal::FromSample<T>,
{
    AudioFrame {
        source: AudioSource::System,
        samples: data
            .iter()
            .map(|sample| sample.to_sample::<f32>())
            .collect(),
        sample_rate,
        channels,
        timestamp_ms,
    }
}

impl AudioCapture for SystemAudioCapture {
    fn start(&mut self) -> Result<(), AudioError> {
        if self.stream.is_some() {
            return Ok(());
        }
        // Discard frames from a stopped/paused stream before reopening it.
        while self.receiver.try_recv().is_ok() {}
        self.take_error();
        self.level.store(0, Ordering::Relaxed);
        self.last_data_ms.store(0, Ordering::Relaxed);
        let device = find_device(
            &cpal::default_host(),
            self.selected_device.as_deref(),
            false,
        )?;
        let supported = device
            .default_output_config()
            .map_err(|error| AudioError::DeviceUnavailable(error.to_string()))?;
        let config = supported.config();
        let started = Instant::now();
        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => self.build_stream::<f32>(&device, &config, started),
            cpal::SampleFormat::F64 => self.build_stream::<f64>(&device, &config, started),
            cpal::SampleFormat::I16 => self.build_stream::<i16>(&device, &config, started),
            cpal::SampleFormat::I32 => self.build_stream::<i32>(&device, &config, started),
            cpal::SampleFormat::U16 => self.build_stream::<u16>(&device, &config, started),
            format => Err(AudioError::DeviceUnavailable(format!(
                "unsupported system audio format: {format:?}"
            ))),
        }?;
        stream
            .play()
            .map_err(|error| AudioError::Capture(error.to_string()))?;
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let sender = self.sender.clone();
        let last_data_ms = self.last_data_ms.clone();
        let level = self.level.clone();
        let silence_thread = thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(50));
                if thread_stop.load(Ordering::Relaxed) {
                    break;
                }
                let now_ms = started.elapsed().as_millis() as u64;
                if send_idle_silence(
                    &sender,
                    config.sample_rate,
                    config.channels,
                    now_ms,
                    last_data_ms.load(Ordering::Relaxed),
                ) {
                    level.store(0, Ordering::Relaxed);
                }
            }
        });
        self.stream = Some(stream);
        self.silence_stop = Some(stop);
        self.silence_thread = Some(silence_thread);
        Ok(())
    }

    fn pause(&mut self) -> Result<(), AudioError> {
        self.stop()
    }
    fn resume(&mut self) -> Result<(), AudioError> {
        self.start()
    }
    fn stop(&mut self) -> Result<(), AudioError> {
        if let Some(stop) = self.silence_stop.take() {
            stop.store(true, Ordering::Relaxed);
        }
        drop(self.stream.take());
        if let Some(thread) = self.silence_thread.take() {
            thread
                .join()
                .map_err(|_| AudioError::Capture("system audio silence worker stopped".into()))?;
        }
        while self.receiver.try_recv().is_ok() {}
        self.level.store(0, Ordering::Relaxed);
        Ok(())
    }
    fn is_running(&self) -> bool {
        self.stream.is_some()
    }
}

impl Drop for SystemAudioCapture {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_preserves_channels_timing_and_reports_errors_without_hardware() {
        let frame = loopback_frame(&[i16::MIN, 0, 0, i16::MAX], 48_000, 2, 125);
        assert_eq!(frame.source, AudioSource::System);
        assert_eq!(
            (frame.sample_rate, frame.channels, frame.timestamp_ms),
            (48_000, 2, 125)
        );
        assert_eq!(frame.samples[0], -1.0);
        assert!(frame.samples[3] > 0.99);
        let mut capture = SystemAudioCapture::new();
        capture.configure(Some("Headphones".into())).unwrap();
        capture.sender.send(frame).unwrap();
        *capture.last_error.lock().unwrap() = Some("device disconnected".into());
        assert_eq!(capture.take_error().as_deref(), Some("device disconnected"));
        assert_eq!(capture.take_error(), None);
        capture.stop().unwrap();
        capture.pause().unwrap();
        assert!(!capture.is_running());
        assert!(capture.frames().is_empty());

        let (sender, receiver) = flume::bounded(2);
        assert!(!send_idle_silence(&sender, 48_000, 2, 99, 0));
        assert!(send_idle_silence(&sender, 48_000, 2, 100, 0));
        let silence = receiver.recv().unwrap();
        assert_eq!(silence.samples.len(), 4_800);
        assert!(silence.samples.iter().all(|sample| *sample == 0.0));
    }
}
