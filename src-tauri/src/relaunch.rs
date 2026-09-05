use std::{
    path::Path,
    process::{Command, Stdio},
};
use tauri::{AppHandle, Manager};

// Launch Services starts the replacement bundle after the old process exits.
// Directly spawning Contents/MacOS/savvy inherits the old process's launch context.
const WAIT_AND_EXEC: &str = r#"
while kill -0 "$1" 2>/dev/null; do sleep 0.1; done
shift
exec "$@"
"#;

fn app_bundle(binary: &Path) -> Option<&Path> {
    let macos = binary.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then_some(bundle)
}

pub fn schedule(app: &AppHandle) -> Result<(), String> {
    let binary = tauri::process::current_binary(&app.env()).map_err(|error| error.to_string())?;
    let bundle =
        app_bundle(&binary).ok_or("Reopen Savvy from its installed application bundle.")?;
    Command::new("/bin/sh")
        .args(["-c", WAIT_AND_EXEC, "savvy-relaunch"])
        .arg(std::process::id().to_string())
        .args(["/usr/bin/open", "-n"])
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("could not schedule Savvy to reopen: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs, thread,
        time::{Duration, Instant},
    };

    #[test]
    fn relaunch_waits_for_exit_and_preserves_literal_arguments() {
        assert_eq!(
            app_bundle(Path::new("/Applications/Savvy.app/Contents/MacOS/savvy")),
            Some(Path::new("/Applications/Savvy.app"))
        );
        assert!(app_bundle(Path::new("/tmp/target/debug/savvy")).is_none());
        let path = std::env::temp_dir().join(format!("savvy-relaunch-{}", uuid::Uuid::new_v4()));
        let mut old = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let literal = "/Applications/Savvy's $(touch unwanted) app.app";
        let mut helper = Command::new("/bin/sh")
            .args(["-c", WAIT_AND_EXEC, "savvy-relaunch"])
            .arg(old.id().to_string())
            .args([
                "/bin/sh",
                "-c",
                "printf '%s' \"$1\" > \"$2\"",
                "test",
                literal,
            ])
            .arg(&path)
            .spawn()
            .unwrap();
        thread::sleep(Duration::from_millis(200));
        assert!(!path.exists());
        old.kill().unwrap();
        old.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = helper.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            if Instant::now() >= deadline {
                let _ = helper.kill();
                let _ = helper.wait();
                panic!("relaunch helper did not finish");
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), literal);
        fs::remove_file(path).unwrap();
    }
}
