"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingStepForm, type TemplateStep } from "@/components/OnboardingStepForm";
import { createClient } from "@/lib/supabase/client";
import { ONBOARDING_PHASE_LABELS, describeDueOffset } from "@/lib/employeeSetup";

const ASSIGNEE_LABELS: Record<string, string> = { employee: "Employee", supervisor: "Supervisor", manager: "Manager", hr: "HR", it: "IT" };

export function OnboardingStepList({ templateId, steps, people = [] }: { templateId: string; steps: TemplateStep[]; people?: { id: string; label: string }[] }) {
  const personById = new Map(people.map((p) => [p.id, p.label]));
  const supabase = createClient();
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleById = new Map(steps.map((s) => [s.id, s.title]));

  async function move(step: TemplateStep, direction: number) {
    setBusyId(step.id);
    setError(null);
    const { error: rpcError } = await supabase.rpc("move_onboarding_template_step", { p_template_id: templateId, p_step_id: step.id, p_direction: direction });
    if (rpcError) setError(rpcError.message);
    setBusyId(null);
    router.refresh();
  }

  async function remove(step: TemplateStep) {
    if (!window.confirm(`Delete "${step.title}" from this template? People already onboarded keep their record.`)) return;
    setBusyId(step.id);
    setError(null);
    const { error: rpcError } = await supabase.rpc("delete_onboarding_template_step", { p_template_id: templateId, p_step_id: step.id });
    if (rpcError) setError(rpcError.message);
    setBusyId(null);
    router.refresh();
  }

  return (
    <div className="space-y-2">
      {error && <p role="alert" className="alert-error">{error}</p>}
      {steps.length === 0 && <p className="text-sm text-stone-400">No steps yet — add the first one below.</p>}
      <ol className="space-y-2">
        {steps.map((s, index) => {
          const showPhase = index === 0 || steps[index - 1].phase !== s.phase;
          return (
            <li key={s.id}>
              {showPhase && <h3 className="mb-1 mt-4 text-xs font-semibold uppercase text-stone-400">{s.phase ? ONBOARDING_PHASE_LABELS[s.phase] ?? s.phase : "Other steps"}</h3>}
              {editingId === s.id ? (
                <div className="rounded-lg border border-stone-200 p-3">
                  <OnboardingStepForm templateId={templateId} step={s} existingSteps={steps.map((x) => ({ id: x.id, title: x.title }))} onDone={() => setEditingId(null)} people={people} />
                </div>
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg bg-cream-100 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-stone-900">{index + 1}. {s.title}</span>
                    {!s.required && <span className="badge badge-neutral ml-2">Optional</span>}
                    <p className="text-xs text-stone-500">
                      {s.step_type.replace(/_/g, " ")} · {ASSIGNEE_LABELS[s.assignee_type] ?? s.assignee_type}
                      {s.assignee_employee_id && personById.get(s.assignee_employee_id) ? ` (${personById.get(s.assignee_employee_id)})` : ""} · {describeDueOffset(s.due_anchor, s.due_offset_days)}
                    </p>
                    {s.dependency_step_ids?.length > 0 && (
                      <p className="text-xs text-stone-400">After: {s.dependency_step_ids.map((d) => titleById.get(d)).filter(Boolean).join(", ")}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button type="button" className="btn-secondary px-2 py-1 text-xs" aria-label={`Move ${s.title} up`} disabled={busyId === s.id || index === 0} onClick={() => move(s, -1)}>↑</button>
                    <button type="button" className="btn-secondary px-2 py-1 text-xs" aria-label={`Move ${s.title} down`} disabled={busyId === s.id || index === steps.length - 1} onClick={() => move(s, 1)}>↓</button>
                    <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setEditingId(s.id)}>Edit</button>
                    <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={busyId === s.id} onClick={() => remove(s)}>Delete</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

type Option = { id: string; label: string };
type AppliesTo = { department_ids?: string[]; org_unit_ids?: string[]; position_ids?: string[]; location_ids?: string[]; employment_types?: string[] };

const EMPLOYMENT_TYPES: Option[] = [
  { id: "full_time", label: "Full-time" }, { id: "part_time", label: "Part-time" }, { id: "contract", label: "Contract" },
  { id: "temporary", label: "Temporary" }, { id: "intern", label: "Intern" },
];

function MultiSelect({ label, options, value, onChange }: { label: string; options: Option[]; value: string[]; onChange: (next: string[]) => void }) {
  return (
    <div>
      <label className="label">{label}</label>
      <select multiple className="input h-24" value={value} onChange={(e) => onChange(Array.from(e.target.selectedOptions, (o) => o.value))}>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <p className="field-help">{value.length === 0 ? "Everyone" : `${value.length} selected`}</p>
    </div>
  );
}

// Template-level settings. applies_to drives recommend_onboarding_template():
// leave a list empty to match everyone.
export function OnboardingTemplateSettings({
  template,
  departments,
  positions,
  locations,
}: {
  template: { id: string; name: string; description: string | null; is_default: boolean; is_active: boolean; applies_to: AppliesTo | null };
  departments: Option[];
  positions: Option[];
  locations: Option[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const applies = template.applies_to ?? {};
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? "");
  const [departmentIds, setDepartmentIds] = useState<string[]>(applies.department_ids ?? applies.org_unit_ids ?? []);
  const [positionIds, setPositionIds] = useState<string[]>(applies.position_ids ?? []);
  const [locationIds, setLocationIds] = useState<string[]>(applies.location_ids ?? []);
  const [employmentTypes, setEmploymentTypes] = useState<string[]>(applies.employment_types ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(label: string, action: () => PromiseLike<{ error: { message: string } | null; data?: unknown }>, after?: (data: unknown) => void) {
    setBusy(label);
    setError(null);
    setMessage(null);
    const { error: actionError, data } = await action();
    if (actionError) setError(actionError.message);
    else {
      after?.(data);
      router.refresh();
    }
    setBusy(null);
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    const appliesTo: AppliesTo = {};
    if (departmentIds.length) appliesTo.department_ids = departmentIds;
    if (positionIds.length) appliesTo.position_ids = positionIds;
    if (locationIds.length) appliesTo.location_ids = locationIds;
    if (employmentTypes.length) appliesTo.employment_types = employmentTypes;
    run("save", () => supabase.from("onboarding_templates").update({ name: name.trim(), description: description.trim() || null, applies_to: appliesTo }).eq("id", template.id), () => setMessage("Template settings saved."));
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="template-name">Name</label>
          <input id="template-name" required className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="template-description">Description</label>
          <input id="template-description" className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase text-stone-400">Recommend this plan for</h3>
        <p className="mb-2 text-xs text-stone-500">HaloManage recommends the most specific matching template when HR sets up a new employee. HR always makes the final choice.</p>
        <div className="grid gap-3 sm:grid-cols-4">
          <MultiSelect label="Departments" options={departments} value={departmentIds} onChange={setDepartmentIds} />
          <MultiSelect label="Positions" options={positions} value={positionIds} onChange={setPositionIds} />
          <MultiSelect label="Locations" options={locations} value={locationIds} onChange={setLocationIds} />
          <MultiSelect label="Employment types" options={EMPLOYMENT_TYPES} value={employmentTypes} onChange={setEmploymentTypes} />
        </div>
      </div>
      {error && <p role="alert" className="alert-error">{error}</p>}
      {message && !error && <p role="status" className="text-xs text-emerald-700">{message}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={busy !== null}>{busy === "save" ? "Saving…" : "Save settings"}</button>
        {!template.is_default && template.is_active && (
          <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => run("default", () => supabase.rpc("set_default_onboarding_template", { p_template_id: template.id }), () => setMessage("This is now your default onboarding plan."))}>Set as default</button>
        )}
        <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => {
          const copyName = window.prompt("Name for the copy", `${template.name} (copy)`);
          if (copyName) run("duplicate", () => supabase.rpc("duplicate_onboarding_template", { p_template_id: template.id, p_name: copyName }), (data) => {
            const copy = data as { id: string } | null;
            if (copy?.id) router.push(`/admin/onboarding/templates/${copy.id}`);
          });
        }}>Duplicate</button>
        {!template.is_default && (
          <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => run("active", () => supabase.from("onboarding_templates").update({ is_active: !template.is_active }).eq("id", template.id), () => setMessage(template.is_active ? "Template disabled — it won't be offered for new employees." : "Template enabled."))}>
            {template.is_active ? "Disable" : "Enable"}
          </button>
        )}
      </div>
    </form>
  );
}
