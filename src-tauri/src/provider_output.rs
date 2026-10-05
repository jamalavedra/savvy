use std::os::unix::process::CommandExt;
use std::{
    io::{self, BufRead, Read},
    path::Path,
    process::Command,
};

pub const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 1024 * 1024;
pub const QUEUE_CAPACITY: usize = 8;

pub fn limit_files(command: &mut Command) {
    // SAFETY: the child hook calls libc directly with stack data, without allocation or locking.
    unsafe {
        command.pre_exec(|| {
            let limit = libc::rlimit {
                rlim_cur: MAX_OUTPUT_BYTES as libc::rlim_t,
                rlim_max: MAX_OUTPUT_BYTES as libc::rlim_t,
            };
            if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }
}

pub fn read_file(path: &Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_OUTPUT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err("Provider output exceeds 4 MiB".into());
    }
    Ok(bytes)
}

pub fn forward_lines(reader: impl BufRead, sender: flume::Sender<String>) -> Result<(), String> {
    let mut reader = reader;
    loop {
        let mut bytes = Vec::new();
        let count = reader
            .by_ref()
            .take(MAX_LINE_BYTES as u64 + 1)
            .read_until(b'\n', &mut bytes)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return Ok(());
        }
        if count > MAX_LINE_BYTES {
            return Err("Codex message exceeds 1 MiB".into());
        }
        let line = String::from_utf8(bytes).map_err(|error| error.to_string())?;
        sender
            .send_timeout(line, std::time::Duration::from_secs(1))
            .map_err(|_| "Codex output queue exceeded its limit or closed".to_owned())?;
    }
}

pub fn account_bytes(total: &mut usize, next: usize) -> Result<(), String> {
    if next > MAX_OUTPUT_BYTES.saturating_sub(*total) {
        return Err("Codex response exceeds 4 MiB".into());
    }
    *total += next;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_output_is_bounded_before_allocation_and_disk_growth() {
        let (sender, receiver) = flume::bounded(QUEUE_CAPACITY);
        forward_lines(io::Cursor::new(b"{}\n"), sender).unwrap();
        assert_eq!(receiver.recv().unwrap(), "{}\n");
        let (sender, _) = flume::bounded(QUEUE_CAPACITY);
        assert!(forward_lines(io::Cursor::new(vec![b'x'; MAX_LINE_BYTES + 1]), sender).is_err());
        let (sender, _receiver) = flume::bounded(QUEUE_CAPACITY);
        assert!(forward_lines(io::Cursor::new("{}\n".repeat(QUEUE_CAPACITY + 1)), sender).is_err());
        let mut total = MAX_OUTPUT_BYTES - 1;
        account_bytes(&mut total, 1).unwrap();
        assert!(account_bytes(&mut total, 1).is_err());
        let path =
            std::env::temp_dir().join(format!("savvy-output-limit-{}", uuid::Uuid::new_v4()));
        let mut command = Command::new("/usr/bin/python3");
        command
            .args([
                "-c",
                "import os,sys; f=open(sys.argv[1],'wb',buffering=0); f.write(b'x'*(5*1024*1024)); f.write(b'x')",
            ])
            .arg(&path);
        command
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        limit_files(&mut command);
        assert!(!command.status().unwrap().success());
        assert!(std::fs::metadata(&path).unwrap().len() <= MAX_OUTPUT_BYTES as u64);
        std::fs::write(&path, vec![b'x'; MAX_OUTPUT_BYTES + 1]).unwrap();
        assert!(read_file(&path).is_err());
        for live in [false, true] {
            let mut command = Command::new("/usr/bin/python3");
            command.args(["-c", "import sys; sys.stdin.read(); f=open(sys.argv[1],'wb',buffering=0); f.write(b'x'*(5*1024*1024)); f.write(b'x')"]).arg(&path)
                .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            let result = if live {
                let slot = std::sync::Mutex::new(None);
                let result = crate::run_claude_child(
                    command.into(),
                    "prompt",
                    &slot,
                    || true,
                    std::time::Duration::from_secs(3),
                );
                assert!(slot.lock().unwrap().is_none());
                result
            } else {
                crate::run_provider_process(
                    command,
                    "prompt",
                    "fixture",
                    std::time::Duration::from_secs(3),
                    None,
                )
            };
            assert!(result.is_err());
            assert!(std::fs::metadata(&path).unwrap().len() <= MAX_OUTPUT_BYTES as u64);
        }
        std::fs::remove_file(path).unwrap();
    }
}
