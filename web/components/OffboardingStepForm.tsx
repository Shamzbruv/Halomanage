"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function OffboardingStepForm({
  templateId,
  nextSequence,
}: {
  templateId: string;
  nextSequence: number;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeType, setAssigneeType] = useState("hr");
  const [dueOffsetDays, setDueOffsetDays] = useState("0");
  const [required, setRequired] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const { error: insertError } = await supabase.from("offboarding_template_steps").insert({
      template_id: templateId,
      title: title.trim(),
      description: description.trim() || null,
      assignee_type: assigneeType,
      sequence: nextSequence,
      due_offset_days: Number(dueOffsetDays || 0),
      required,
    });

    if (insertError) {
      setError(insertError.message);
      setLoading(false);
      return;
    }

    setTitle("");
    setDescription("");
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-4">
      <div>
        <span className="eyebrow">Checklist builder</span>
        <h2 className="mt-1 text-base font-semibold text-stone-900">Add step {nextSequence}</h2>
        <p className="mt-1 text-xs leading-5 text-stone-500">Create a clear owner and due date for every handoff.</p>
      </div>
      <div>
        <label className="label" htmlFor="offboarding-step-title">Task title</label>
        <input
          id="offboarding-step-title"
          required
          placeholder="Collect company equipment"
          className="input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor="offboarding-step-description">Instructions <span className="label-hint">Optional</span></label>
        <textarea
          id="offboarding-step-description"
          placeholder="List the laptop, access card, keys, or other items to return."
          className="input"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="offboarding-assignee">Owner</label>
          <select id="offboarding-assignee" className="input" value={assigneeType} onChange={(event) => setAssigneeType(event.target.value)}>
            <option value="hr">HR / administrator</option>
            <option value="employee">Departing employee</option>
            <option value="supervisor">Supervisor</option>
            <option value="manager">Manager</option>
            <option value="it">IT</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="offboarding-due-offset">Due after start</label>
          <div className="flex items-center gap-2">
            <input
              id="offboarding-due-offset"
              type="number"
              min={0}
              max={365}
              className="input"
              value={dueOffsetDays}
              onChange={(event) => setDueOffsetDays(event.target.value)}
            />
            <span className="text-xs text-stone-400">days</span>
          </div>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-stone-600">
        <input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />
        Required before the exit can be completed
      </label>
      {error && <p className="alert-error" role="alert">{error}</p>}
      <button type="submit" disabled={loading || !title.trim()} className="btn-primary">
        {loading ? "Adding…" : "Add checklist step"}
      </button>
    </form>
  );
}
