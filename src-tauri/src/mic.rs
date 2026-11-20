//! Push-to-talk microphone capture, done natively with cpal so it behaves the
//! same in every OS webview. Output: mono f32 samples at 16 kHz for Whisper.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

pub const TARGET_RATE: u32 = 16_000;

struct Recording {
    stop_tx: mpsc::Sender<()>,
    done_rx: mpsc::Receiver<(Vec<f32>, u32)>,
}

#[derive(Default)]
pub struct Mic {
    current: Mutex<Option<Recording>>,
}

impl Mic {
    /// Start recording from the input device called `device` ("" = the system default).
    pub fn start(&self, device: &str) -> Result<(), String> {
        let device = device.to_string();
        let mut cur = self.current.lock().unwrap();
        if let Some(old) = cur.take() {
            let _ = old.stop_tx.send(());
        }
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (done_tx, done_rx) = mpsc::channel::<(Vec<f32>, u32)>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

        // cpal streams aren't Send on every platform, so each recording owns a thread.
        thread::spawn(move || {
            let buf = Arc::new(Mutex::new(Vec::<f32>::with_capacity(16_000 * 30)));
            let (stream, rate) = match open_stream(buf.clone(), &device) {
                Ok(v) => v,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            if let Err(e) = stream.play() {
                let _ = ready_tx.send(Err(e.to_string()));
                return;
            }
            let _ = ready_tx.send(Ok(()));
            let _ = stop_rx.recv();
            drop(stream);
            let samples = std::mem::take(&mut *buf.lock().unwrap());
            let _ = done_tx.send((samples, rate));
        });

        ready_rx.recv().map_err(|e| e.to_string())??;
        *cur = Some(Recording { stop_tx, done_rx });
        Ok(())
    }

    /// Stop and return 16 kHz mono samples.
    pub fn stop(&self) -> Result<Vec<f32>, String> {
        let rec = self.current.lock().unwrap().take().ok_or("not recording")?;
        let _ = rec.stop_tx.send(());
        let (samples, rate) = rec.done_rx.recv().map_err(|e| e.to_string())?;
        Ok(resample(&samples, rate, TARGET_RATE))
    }

    pub fn cancel(&self) {
        if let Some(rec) = self.current.lock().unwrap().take() {
            let _ = rec.stop_tx.send(());
        }
    }
}

/// Names of the microphones / input devices this computer has (for the settings menu).
pub fn input_devices() -> Vec<String> {
    let host = cpal::default_host();
    let mut names: Vec<String> = host
        .input_devices()
        .map(|it| it.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default();
    names.dedup();
    names
}

/// The device called `name`, or the system default if it's empty or no longer plugged in.
fn pick_device(name: &str) -> Option<cpal::Device> {
    let host = cpal::default_host();
    if !name.is_empty() {
        if let Ok(mut devices) = host.input_devices() {
            if let Some(d) = devices.find(|d| d.name().map(|n| n == name).unwrap_or(false)) {
                return Some(d);
            }
        }
        eprintln!("microphone \"{name}\" not found, using the default one");
    }
    host.default_input_device()
}

fn open_stream(buf: Arc<Mutex<Vec<f32>>>, device_name: &str) -> Result<(cpal::Stream, u32), String> {
    let device = pick_device(device_name).ok_or("no microphone found")?;
    let config = device.default_input_config().map_err(|e| e.to_string())?;
    let rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let stream = match config.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, &config.into(), channels, buf, |s| s),
        SampleFormat::I16 => build::<i16>(&device, &config.into(), channels, buf, |s| s as f32 / 32768.0),
        SampleFormat::U16 => build::<u16>(&device, &config.into(), channels, buf, |s| (s as f32 - 32768.0) / 32768.0),
        SampleFormat::I32 => build::<i32>(&device, &config.into(), channels, buf, |s| s as f32 / 2147483648.0),
        other => return Err(format!("unsupported microphone format {other:?}")),
    }?;
    Ok((stream, rate))
}

fn build<T: SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    buf: Arc<Mutex<Vec<f32>>>,
    conv: fn(T) -> f32,
) -> Result<cpal::Stream, String> {
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let mut out = buf.lock().unwrap();
                for frame in data.chunks(channels.max(1)) {
                    let sum: f32 = frame.iter().map(|s| conv(*s)).sum();
                    out.push(sum / frame.len() as f32);
                }
            },
            |e| eprintln!("microphone error: {e}"),
            None,
        )
        .map_err(|e| e.to_string())
}

/// Simple linear-interpolating resampler (with box averaging when downsampling).
fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = (input.len() as f64 / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let start = i as f64 * ratio;
        if ratio > 1.0 {
            let a = start as usize;
            let b = ((start + ratio) as usize).min(input.len()).max(a + 1);
            let sum: f32 = input[a..b].iter().sum();
            out.push(sum / (b - a) as f32);
        } else {
            let a = start.floor() as usize;
            let b = (a + 1).min(input.len() - 1);
            let t = (start - a as f64) as f32;
            out.push(input[a] * (1.0 - t) + input[b] * t);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs real audio devices, so it only runs when asked: `cargo test -- --ignored mic`
    #[test]
    #[ignore]
    fn records_from_a_chosen_device_and_falls_back_to_the_default() {
        let names = input_devices();
        println!("input devices: {names:?}");
        assert!(!names.is_empty(), "no input devices on this machine");
        let mic = Mic::default();
        for name in [names[names.len() - 1].as_str(), "no such microphone", ""] {
            mic.start(name).unwrap_or_else(|e| panic!("start({name:?}) failed: {e}"));
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let pcm = mic.stop().expect("stop");
            println!("{name:?}: {} samples at 16 kHz", pcm.len());
            assert!(pcm.len() > 3000, "recorded too little from {name:?}");
        }
    }
}

