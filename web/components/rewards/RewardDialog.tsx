"use client";
import { useEffect, useId, useRef } from "react";
export function RewardDialog({
  open,
  onClose,
  title,
  busy,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  busy: boolean;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    titleId = useId();
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="recognition-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      onClose={onClose}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={onClose}
          aria-label={`Close ${title}`}
        >
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}
