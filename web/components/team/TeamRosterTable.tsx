"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";

export type RosterRow = {
  id: string;
  name: string;
  employeeNumber: string;
  email: string | null;
  status: string;
  positionTitle: string | null;
  departmentName: string | null;
  supervisorId: string | null;
  supervisorName: string | null;
  managerName: string | null;
  scheduleName: string | null;
  leaveSummary: string;
};

function initials(name: string) {
  return name.split(" ").filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "TM";
}

// Filters client-side (the roster is already fully RLS-scoped and loaded —
// searching further out-of-scope employees isn't offered, since scope is
// the actual permission boundary, not a UI convenience) and groups by
// direct supervisor so a wide "organization" view reads as an org chart,
// not a flat, unordered list.
export function TeamRosterTable({ rows }: { rows: RosterRow[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      row.name.toLowerCase().includes(q) ||
      row.employeeNumber.toLowerCase().includes(q) ||
      (row.email ?? "").toLowerCase().includes(q) ||
      (row.positionTitle ?? "").toLowerCase().includes(q) ||
      (row.departmentName ?? "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  const groups = useMemo(() => {
    const byKey = new Map<string, { label: string; rows: RosterRow[] }>();
    for (const row of filtered) {
      const key = row.supervisorId ?? "unassigned";
      const label = row.supervisorName ?? "No supervisor assigned";
      if (!byKey.has(key)) byKey.set(key, { label, rows: [] });
      byKey.get(key)!.rows.push(row);
    }
    return Array.from(byKey.values()).sort((a, b) => {
      if (a.label === "No supervisor assigned") return 1;
      if (b.label === "No supervisor assigned") return -1;
      return a.label.localeCompare(b.label);
    });
  }, [filtered]);

  // Grouping only earns its keep once there's more than one supervisor to
  // tell apart — a plain Supervisor/Manager viewing just their own reports
  // would otherwise see a single, redundant "Reports to You" heading.
  const showGroupHeadings = groups.length > 1;

  return (
    <div className="space-y-5">
      <div className="relative max-w-sm">
        <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
        <input
          type="search"
          className="input pl-9"
          placeholder="Search by name, ID, email, or position…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search team roster"
        />
      </div>

      {rows.length === 0 && <p className="py-8 text-center text-stone-400">No employees are currently visible in this scope.</p>}
      {rows.length > 0 && filtered.length === 0 && <p className="py-8 text-center text-stone-400">No one matches &ldquo;{query}&rdquo;.</p>}

      {groups.map((group) => (
        <div key={group.label}>
          {showGroupHeadings && (
            <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
              <Icon name="team" size={14} /> Reports to {group.label}
              <span className="font-normal normal-case text-stone-400">({group.rows.length})</span>
            </h4>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-100 text-left">
                <th className="pb-2">Employee</th>
                <th className="pb-2">Position</th>
                <th className="pb-2">Manager</th>
                <th className="pb-2">Schedule</th>
                <th className="pb-2">Leave available</th>
                <th className="pb-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {group.rows.map((row) => (
                <tr key={row.id}>
                  <td className="py-3">
                    <Link href={`/team/${row.id}`} className="flex items-center gap-2 hover:opacity-80">
                      <span className="user-avatar small">{initials(row.name)}</span>
                      <span>
                        <strong className="block font-medium text-stone-900">{row.name}</strong>
                        <small className="text-stone-500">{row.employeeNumber}{row.email ? ` · ${row.email}` : ""}</small>
                      </span>
                    </Link>
                  </td>
                  <td className="py-3 text-stone-600">{row.positionTitle ?? "—"}</td>
                  <td className="py-3 text-stone-600">{row.managerName ?? "—"}</td>
                  <td className="py-3 text-stone-600">{row.scheduleName ?? <span className="text-amber-700">Not assigned</span>}</td>
                  <td className="py-3 text-stone-600">{row.leaveSummary || <span className="text-amber-700">Not provisioned</span>}</td>
                  <td className="py-3"><span className={`badge ${row.status === "active" ? "badge-emerald" : "badge-neutral"}`}>{row.status.replace(/_/g, " ")}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
