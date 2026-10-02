"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime } from "@/lib/timezone";

export const HR_NOTE_CATEGORIES: Record<string, string> = {
  general: "General HR",
  employee_relations: "Employee relations",
  compliance: "Compliance",
  manager_note: "Manager note",
  confidential: "Confidential HR",
};

export type HrNote = { id: string; category: string; body: string; created_at: string; created_by_name: string | null; updated_at: string };

// employee_hr_notes: readable and writable only with employee.manage —
// never by the employee, never by their supervisor or manager. The audit
// trail records that a note was added, never its text.
export function EmployeeHrNotes({
  organizationId,
  employeeId,
  notes,
  timezone,
}: {
  organizationId: string;
  employeeId: string;
  notes: HrNote[];
  timezone: string | undefined;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [category, setCategory] = useState("general");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: insertError } = await supabase.from("employee_hr_notes").insert({
      organization_id: organizationId, employee_id: employeeId, category, body: body.trim(),
    });
    if (insertError) setError(insertError.message);
    else setBody("");
    setLoading(false);
    router.refresh();
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this HR note? Its deletion is recorded in the audit trail.")) return;
    setBusyId(id);
    const { error: deleteError } = await supabase.from("employee_hr_notes").delete().eq("id", id);
    if (deleteError) setError(deleteError.message);
    setBusyId(null);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <form onSubmit={add} className="space-y-3 rounded-xl border border-stone-100 p-3">
        <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
          <div>
            <label className="label" htmlFor="hr-note-category">Category</label>
            <select id="hr-note-category" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
              {Object.entries(HR_NOTE_CATEGORIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="hr-note-body">Note</label>
            <textarea id="hr-note-body" rows={3} className="input" value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
        </div>
        {error && <p role="alert" className="alert-error">{error}</p>}
        <button type="submit" className="btn-primary" disabled={loading || !body.trim()}>{loading ? "Saving…" : "Add note"}</button>
      </form>
      <ul className="space-y-2">
        {notes.length === 0 && <li className="text-sm text-stone-400">No HR notes.</li>}
        {notes.map((note) => (
          <li key={note.id} className="rounded-lg bg-cream-100 px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="badge badge-neutral">{HR_NOTE_CATEGORIES[note.category] ?? note.category}</span>
              <span className="text-xs text-stone-500">{formatDateTime(note.created_at, timezone, { dateStyle: "medium", timeStyle: "short" })}{note.created_by_name ? ` · ${note.created_by_name}` : ""}</span>
            </div>
            <p className="mt-1.5 whitespace-pre-wrap text-stone-800">{note.body}</p>
            <button type="button" className="mt-1 text-xs text-ruby-600 hover:underline" disabled={busyId === note.id} onClick={() => remove(note.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
