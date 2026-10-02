"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DUE_ANCHOR_LABELS, ONBOARDING_PHASE_LABELS, describeDueOffset } from "@/lib/employeeSetup";

export type TemplateStep = {
  id: string;
  title: string;
  description: string | null;
  step_type: string;
  assignee_type: string;
  due_anchor: string;
  due_offset_days: number;
  required: boolean;
  phase: string | null;
  assignee_employee_id?: string | null;
  dependency_step_ids: string[];
};

const STEP_TYPES = [
  ["task", "Task"], ["form", "Form"], ["document_upload", "Document upload"], ["document_review", "Document review"],
  ["acknowledgement", "Acknowledgement"], ["signature", "Signature"], ["training", "Training"], ["meeting", "Meeting"],
  ["approval", "Approval"], ["checkpoint", "Checkpoint"],
] as const;

const ASSIGNEES = [["employee", "Employee"], ["supervisor", "Supervisor"], ["manager", "Manager"], ["hr", "HR"], ["it", "IT"]] as const;

// Every save goes through save_onboarding_template_step(): if employees have
// already been onboarded with the current version, the database first
// copies it to a new version, so their permanent records never change.
export function OnboardingStepForm({
  templateId,
  existingSteps,
  step,
  onDone,
  people = [],
}: {
  templateId: string;
  existingSteps: { id: string; title: string }[];
  step?: TemplateStep;
  onDone?: () => void;
  // For HR/IT steps: an optional named owner, overriding the
  // organization's default owner for that kind of step.
  people?: { id: string; label: string }[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [form, setForm] = useState({
    title: step?.title ?? "",
    description: step?.description ?? "",
    step_type: step?.step_type ?? "task",
    assignee_type: step?.assignee_type ?? "employee",
    due_anchor: step?.due_anchor ?? "hire_date",
    due_offset_days: String(step?.due_offset_days ?? 0),
    required: step?.required ?? true,
    phase: step?.phase ?? "",
    assignee_employee_id: step?.assignee_employee_id ?? "",
  });
  const namedOwnerAllowed = form.assignee_type === "hr" || form.assignee_type === "it";
  const [dependsOn, setDependsOn] = useState<string[]>(step?.dependency_step_ids ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("save_onboarding_template_step", {
      p_template_id: templateId,
      p_step_id: step?.id ?? null,
      p_title: form.title,
      p_description: form.description || null,
      p_step_type: form.step_type,
      p_assignee_type: form.assignee_type,
      p_due_anchor: form.due_anchor,
      p_due_offset_days: Number(form.due_offset_days || 0),
      p_required: form.required,
      p_phase: form.phase || null,
      p_dependency_step_ids: dependsOn,
      p_assignee_employee_id: namedOwnerAllowed ? form.assignee_employee_id || null : null,
    });
    if (rpcError) {
      setError(rpcError.message);
      setLoading(false);
      return;
    }
    if (!step) {
      setForm((current) => ({ ...current, title: "", description: "" }));
      setDependsOn([]);
    }
    setLoading(false);
    onDone?.();
    router.refresh();
  }

  const candidates = existingSteps.filter((s) => s.id !== step?.id);

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`step-title-${step?.id ?? "new"}`}>Title</label>
          <input id={`step-title-${step?.id ?? "new"}`} required placeholder="e.g. Upload identification" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`step-description-${step?.id ?? "new"}`}>Instructions</label>
          <textarea id={`step-description-${step?.id ?? "new"}`} rows={2} className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div>
          <label className="label">Phase</label>
          <select className="input" value={form.phase} onChange={(e) => setForm({ ...form, phase: e.target.value })}>
            <option value="">No phase</option>
            {Object.entries(ONBOARDING_PHASE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Type</label>
          <select className="input" value={form.step_type} onChange={(e) => setForm({ ...form, step_type: e.target.value })}>
            {STEP_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Who completes it</label>
          <select className="input" value={form.assignee_type} onChange={(e) => setForm({ ...form, assignee_type: e.target.value })}>
            {ASSIGNEES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        {namedOwnerAllowed && people.length > 0 && (
          <div>
            <label className="label">Specific person (optional)</label>
            <select className="input" value={form.assignee_employee_id} onChange={(e) => setForm({ ...form, assignee_employee_id: e.target.value })}>
              <option value="">Organization&apos;s {form.assignee_type.toUpperCase()} owner</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
        )}
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-stone-600">
          <input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} /> Required to finish onboarding
        </label>
        <div>
          <label className="label">Due — days (negative = before)</label>
          <input type="number" className="input" value={form.due_offset_days} onChange={(e) => setForm({ ...form, due_offset_days: e.target.value })} />
        </div>
        <div>
          <label className="label">Relative to</label>
          <select className="input" value={form.due_anchor} onChange={(e) => setForm({ ...form, due_anchor: e.target.value })}>
            {Object.entries(DUE_ANCHOR_LABELS).map(([value, label]) => <option key={value} value={value}>{label.charAt(0).toUpperCase() + label.slice(1)}</option>)}
          </select>
        </div>
        <p className="text-xs text-stone-500 sm:col-span-2">Due: {describeDueOffset(form.due_anchor, Number(form.due_offset_days || 0))}.</p>
      </div>
      {candidates.length > 0 && (
        <div>
          <label className="label">Depends on (must be finished first)</label>
          <select multiple className="input h-24" value={dependsOn} onChange={(e) => setDependsOn(Array.from(e.target.selectedOptions, (o) => o.value))}>
            {candidates.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </div>
      )}
      {error && <p role="alert" className="alert-error">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={loading || !form.title.trim()} className="btn-primary">{loading ? "Saving…" : step ? "Save step" : "Add step"}</button>
        {onDone && step && <button type="button" className="btn-secondary" onClick={onDone}>Cancel</button>}
      </div>
    </form>
  );
}
