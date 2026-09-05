"use client";

import { Icon } from "@/components/Icon";

// A payslip is exactly what's on screen — printing it (browser "Save as
// PDF" destination works everywhere) avoids taking on a PDF-generation
// dependency for a document that's already laid out for paper via the
// @media print rules in globals.css.
export function PrintPayslipButton() {
  return (
    <button type="button" className="btn-primary no-print" onClick={() => window.print()}>
      <Icon name="download" size={16} /> Print / Save as PDF
    </button>
  );
}
