"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";

// A small "?" affordance for explaining what a page or section is for, in
// plain language, right where the confusion happens — rather than relying
// on a help center the person has to go find. Click (not hover) so it
// works the same on touch devices; dismisses on an outside click or Escape.
export function HelpTip({ title, children }: { title?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span className="help-tip" ref={containerRef}>
      <button
        type="button"
        className="help-tip-trigger"
        aria-expanded={open}
        aria-label={title ? `What is ${title}?` : "What is this?"}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="help" size={13} />
      </button>
      {open && (
        <span className="help-tip-panel" role="tooltip">
          {title && <strong>{title}</strong>}
          <span>{children}</span>
        </span>
      )}
    </span>
  );
}
