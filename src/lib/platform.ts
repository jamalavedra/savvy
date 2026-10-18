export function isWindows() {
  return document.documentElement.dataset.platform === "windows";
}

export function defaultListeningShortcut() {
  return isWindows() ? "Control+Shift+M" : "Command+Shift+M";
}

export function formatShortcut(value: string) {
  if (isWindows()) {
    return value
      .replace("Command", "Win")
      .replace("Control", "Ctrl")
      .replace("Option", "Alt");
  }
  return value
    .replace("Command", "⌘")
    .replace("Control", "⌃")
    .replace("Option", "⌥")
    .replace("Shift", "⇧")
    .split("+")
    .join(" ");
}
