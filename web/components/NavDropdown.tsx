"use client";

import { useRef } from "react";

// A small client island so the rest of the portal layout can stay a server
// component. Native <details>/<summary> handles the open/close state; this
// just closes it when a link inside is clicked (native details doesn't).
export function NavDropdown({ label, children }: { label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);

  return (
    <details ref={ref} className="nav-dropdown" onClick={(e) => {
      if ((e.target as HTMLElement).tagName === "A" && ref.current) ref.current.open = false;
    }}>
      <summary className="transition-colors hover:text-gold-200">{label}</summary>
      <div className="nav-dropdown-menu">{children}</div>
    </details>
  );
}
