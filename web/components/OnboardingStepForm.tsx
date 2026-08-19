"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function OnboardingStepForm({
  templateVersionId,
  nextSequence,
  existingSteps,
}: {
  templateVersionId: string;
  nextSequence: number;
  existingSteps: { id: string; title: string }[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [stepType, setStepType] = useState("task");
  const [assigneeType, setAssigneeType] = useState("employee");
  const [dueOffsetDays, setDueOffsetDays] = useState("3");
  const [required, setRequired] = useState(true);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.from("onboarding_template_steps").insert({
      template_version_id: templateVersionId,
      title,
      step_type: stepType,
      assignee_type: assigneeType,
      sequence: nextSequence,
      due_offset_days: Number(dueOffsetDays || 0),
      required,
      dependency_step_ids: dependsOn,
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setTitle("");
    setDependsOn([]);
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-3">
      <h3 className="text-sm font-semibold text-stone-900">Add step {nextSequence}</h3>
      <input required placeholder="Step title (e.g. Upload identification)" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <select className="input" value={stepType} onChange={(e) => setStepType(e.target.value)}>
          <option value="task">Task</option>
          <option value="form">Form</option>
          <option value="document_upload">Document upload</option>
          <option value="document_review">Document review</option>
          <option value="acknowledgement">Acknowledgement</option>
          <option value="signature">Signature</option>
          <option value="training">Training</option>
          <option value="meeting">Meeting</option>
          <option value="approval">Approval</option>
          <option value="checkpoint">Checkpoint</option>
        </select>
        <select className="input" value={assigneeType} onChange={(e) => setAssigneeType(e.target.value)}>
          <option value="employee">Employee</option>
          <option value="supervisor">Supervisor</option>
          <option value="manager">Manager</option>
          <option value="hr">HR</option>
          <option value="it">IT</option>
        </select>
        <input type="number" min={0} className="input" placeholder="Due (days)" value={dueOffsetDays} onChange={(e) => setDueOffsetDays(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-stone-600">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required
        </label>
      </div>
      {existingSteps.length > 0 && (
        <div>
          <label className="label">Depends on (must complete first)</label>
          <select
            multiple
            className="input h-24"
            value={dependsOn}
            onChange={(e) => setDependsOn(Array.from(e.target.selectedOptions, (o) => o.value))}
          >
            {existingSteps.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </div>
      )}
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={loading || !title} className="btn-primary">
        {loading ? "Adding…" : "Add step"}
      </button>
    </form>
  );
}
