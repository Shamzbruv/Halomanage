"use client";

// Downloads already-loaded report rows as CSV — nothing is re-queried, so
// the file always matches what's on screen.
export function CsvDownloadButton({ filename, headers, rows, label = "Download CSV" }: { filename: string; headers: string[]; rows: (string | number | null)[][]; label?: string }) {
  function download() {
    const escape = (value: string | number | null) => {
      const text = value === null ? "" : String(value);
      // Neutralize spreadsheet formulas in text cells.
      const safe = /^[=+\-@]/.test(text) && typeof value === "string" ? `'${text}` : text;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const csv = [headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }
  return <button type="button" className="btn-secondary" onClick={download} disabled={rows.length === 0}>{label}</button>;
}
