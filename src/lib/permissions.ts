export async function requestPermissionDecision(
  request: () => Promise<unknown>,
  check: () => Promise<boolean>,
) {
  let promptOpened = false;
  let finishWaiting = () => {};
  const promptClosed = new Promise<void>((resolve) => {
    finishWaiting = resolve;
  });
  const onBlur = () => {
    promptOpened = true;
  };
  const onFocus = () => {
    if (promptOpened) finishWaiting();
  };
  const initiallyFocused = document.hasFocus();
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  try {
    await request();
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    if (initiallyFocused && !document.hasFocus()) promptOpened = true;
    if (promptOpened) await promptClosed;
    return check();
  } finally {
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", onFocus);
  }
}
