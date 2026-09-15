use std::{
    path::{Path, PathBuf},
    process::{Child, Command},
};

#[cfg(target_os = "macos")]
pub fn find(name: &str) -> Result<PathBuf, String> {
    if !["codex", "claude"].contains(&name) {
        return Err("unsupported recommendation provider".into());
    }
    if let Some(home) = std::env::var_os("HOME") {
        let official = PathBuf::from(home).join(".local/bin").join(name);
        if official.is_file() {
            return Ok(official);
        }
    }
    let output = Command::new("/bin/zsh")
        .args(["-lc", &format!("command -v {name}")])
        .output()
        .map_err(|error| format!("could not locate {name}: {error}"))?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .map(str::trim)
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .ok_or_else(|| format!("{name} is not installed or not on PATH"))
}

#[cfg(target_os = "windows")]
pub fn find(name: &str) -> Result<PathBuf, String> {
    let mut directories = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE") {
        directories.push(PathBuf::from(home).join(".local/bin"));
    }
    directories.extend(path_directories());
    if let Some(roaming) = std::env::var_os("APPDATA") {
        directories.push(PathBuf::from(roaming).join("npm"));
    }
    find_windows(name, &directories)
        .ok_or_else(|| format!("{name} is not installed for Windows or not on PATH. Install the Windows CLI and reopen Savvy."))
}

#[cfg(any(target_os = "windows", test))]
fn find_windows(name: &str, directories: &[PathBuf]) -> Option<PathBuf> {
    let entrypoint = match name {
        "codex" => "node_modules/@openai/codex/bin/codex.js",
        "claude" => "node_modules/@anthropic-ai/claude-code/cli.js",
        _ => return None,
    };
    directories
        .iter()
        .flat_map(|directory| {
            [
                directory.join(format!("{name}.exe")),
                directory.join(entrypoint),
            ]
        })
        .find(|path| path.is_file())
}

#[cfg(target_os = "windows")]
fn path_directories() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect())
        .unwrap_or_default()
}

pub fn command(binary: impl AsRef<Path>) -> Result<Command, String> {
    let binary = binary.as_ref();
    #[cfg(target_os = "macos")]
    let command = Command::new(binary);
    #[cfg(target_os = "windows")]
    let command = {
        use std::os::windows::process::CommandExt;
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        let mut command = if binary
            .extension()
            .is_some_and(|extension| extension == "js")
        {
            let node = binary
                .ancestors()
                .skip(1)
                .map(|directory| directory.join("node.exe"))
                .chain(
                    path_directories()
                        .into_iter()
                        .map(|directory| directory.join("node.exe")),
                )
                .find(|path| path.is_file())
                .ok_or("Node.js is required for the npm-installed recommendation CLI")?;
            let mut command = Command::new(node);
            // Bypass .cmd/.ps1 wrappers: prompts and schemas never pass through a shell.
            command.arg(binary);
            command
        } else {
            Command::new(binary)
        };
        command.creation_flags(CREATE_NO_WINDOW.0);
        command
    };
    Ok(command)
}

pub fn terminate(child: &mut Child) {
    #[cfg(target_os = "windows")]
    if let Ok(Some(_)) = child.try_wait() {
        return;
    }
    #[cfg(target_os = "windows")]
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        // npm entrypoints can spawn native children. Stop the whole tree before
        // closing its pipes, otherwise a cancelled request can keep running.
        if let Ok(mut command) = command(PathBuf::from(system_root).join("System32/taskkill.exe")) {
            let _ = command
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn npm_arguments_round_trip_without_cmd_expansion() {
        let directory =
            std::env::temp_dir().join(format!("savvy arguments {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let script = directory.join("arguments.js");
        std::fs::write(
            &script,
            "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
        )
        .unwrap();
        let arguments = [
            r#"{"text":"quotes, spaces & | < > ^ %PATH% !"}"#,
            "",
            "C:\\folder with spaces\\",
        ];
        let output = command(&script).unwrap().args(arguments).output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            serde_json::from_slice::<Vec<String>>(&output.stdout).unwrap(),
            arguments
        );
        std::fs::write(&script, "setInterval(() => {}, 1000)").unwrap();
        let mut child = command(&script).unwrap().spawn().unwrap();
        terminate(&mut child);
        assert!(child.try_wait().unwrap().is_some());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn windows_discovery_supports_native_and_npm_installs_without_shell_wrappers() {
        let directory =
            std::env::temp_dir().join(format!("savvy provider test {}", uuid::Uuid::new_v4()));
        let entry = directory.join("node_modules/@openai/codex/bin/codex.js");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "").unwrap();
        let directories = [directory.clone()];
        assert_eq!(find_windows("codex", &directories), Some(entry));
        let native = directory.join("codex.exe");
        std::fs::write(&native, "").unwrap();
        assert_eq!(find_windows("codex", &directories), Some(native));
        std::fs::write(directory.join("claude.cmd"), "must not execute").unwrap();
        assert_eq!(find_windows("claude", &directories), None);
        assert_eq!(find_windows("../codex", &directories), None);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
