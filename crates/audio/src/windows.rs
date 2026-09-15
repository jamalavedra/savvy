use super::*;

pub struct SystemAudioCapture {
    stream: Option<cpal::Stream>,
    selected_device: Option<String>,
    sender: Sender<AudioFrame>,
    receiver: Receiver<AudioFrame>,
    last_error: Arc<Mutex<Option<String>>>,
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
            selected_device: None,
            sender,
            receiver,
            last_error: Arc::new(Mutex::new(None)),
        }
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
    ) -> Result<cpal::Stream, AudioError>
    where
        T: cpal::SizedSample,
        f32: cpal::FromSample<T>,
    {
        let sender = self.sender.clone();
        let sample_rate = config.sample_rate;
        let channels = config.channels;
        let started = Instant::now();
        // CPAL enables WASAPI loopback when an output device is opened for input.
        device
            .build_input_stream(
                config,
                move |data: &[T], _| {
                    let _ = sender.try_send(loopback_frame(
                        data,
                        sample_rate,
                        channels,
                        started.elapsed().as_millis() as u64,
                    ));
                },
                capture_error(self.last_error.clone()),
                None,
            )
            .map_err(|error| AudioError::Capture(error.to_string()))
    }
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
        let device = find_device(
            &cpal::default_host(),
            self.selected_device.as_deref(),
            false,
        )?;
        let supported = device
            .default_output_config()
            .map_err(|error| AudioError::DeviceUnavailable(error.to_string()))?;
        let config = supported.config();
        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => self.build_stream::<f32>(&device, &config),
            cpal::SampleFormat::F64 => self.build_stream::<f64>(&device, &config),
            cpal::SampleFormat::I16 => self.build_stream::<i16>(&device, &config),
            cpal::SampleFormat::I32 => self.build_stream::<i32>(&device, &config),
            cpal::SampleFormat::U16 => self.build_stream::<u16>(&device, &config),
            format => Err(AudioError::DeviceUnavailable(format!(
                "unsupported system audio format: {format:?}"
            ))),
        }?;
        stream
            .play()
            .map_err(|error| AudioError::Capture(error.to_string()))?;
        self.stream = Some(stream);
        Ok(())
    }

    fn pause(&mut self) -> Result<(), AudioError> {
        self.stop()
    }
    fn resume(&mut self) -> Result<(), AudioError> {
        self.start()
    }
    fn stop(&mut self) -> Result<(), AudioError> {
        drop(self.stream.take());
        while self.receiver.try_recv().is_ok() {}
        Ok(())
    }
    fn is_running(&self) -> bool {
        self.stream.is_some()
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
    }
}
