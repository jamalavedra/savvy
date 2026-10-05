import { useEffect, useRef } from "react";
export default function ConfirmDialog({
  title,
  children,
  confirm,
  onConfirm,
  onCancel,
  busy = false,
}: {
  title: string;
  children: React.ReactNode;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    cancel.current?.focus();
    return () => {
      element?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      className="confirmation-dialog"
      ref={dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2>{title}</h2>
      {children}
      <div className="onboarding-actions">
        <button
          className="button secondary"
          ref={cancel}
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button className="button" onClick={onConfirm} disabled={busy}>
          {confirm}
        </button>
      </div>
    </dialog>
  );
}
