import { Button } from "./ui";
import { useEffect, useRef } from "react";
export default function ConfirmDialog({
  title,
  children,
  confirm,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  busy = false,
  confirmVariant = "primary",
}: {
  title: string;
  children: React.ReactNode;
  confirm: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  confirmVariant?: "primary" | "secondary" | "danger";
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
        <Button ref={cancel} onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button variant={confirmVariant} onClick={onConfirm} disabled={busy}>
          {confirm}
        </Button>
      </div>
    </dialog>
  );
}
