import type { KeyboardEvent } from "react";

export function moveListboxFocus(event: KeyboardEvent<HTMLElement>) {
  const target = event.target;
  if (
    ["Enter", " "].includes(event.key) &&
    target instanceof HTMLButtonElement &&
    target === document.activeElement &&
    target.getAttribute("role") === "option" &&
    !target.matches(":disabled") &&
    target.getAttribute("aria-disabled") !== "true"
  ) {
    event.preventDefault();
    target.click();
    return;
  }
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  if (
    event.target instanceof HTMLInputElement &&
    ["Home", "End"].includes(event.key)
  )
    return;
  const options = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="option"]:not(:disabled)',
    ),
  );
  if (!options.length) return;
  const current = options.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : event.key === "ArrowDown"
          ? (current + 1) % options.length
          : current < 0
            ? options.length - 1
            : (current - 1 + options.length) % options.length;
  event.preventDefault();
  options[next].focus();
}
