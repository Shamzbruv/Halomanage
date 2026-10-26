"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  DUE_ANCHOR_LABELS,
  ONBOARDING_PHASE_LABELS,
  describeDueOffset,
} from "@/lib/employeeSetup";

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
  form_schema?: {
    fields: { key: string; label: string; type: string; required: boolean }[];
  } | null;
  review_document_id?: string | null;
};

const STEP_TYPES = [
  ["task", "Task"],
  ["form", "Form"],
  ["document_upload", "Document upload"],
  ["document_review", "Document review"],
  ["acknowledgement", "Acknowledgement"],
  ["signature", "Account attestation"],
  ["training", "Training"],
  ["meeting", "Meeting"],
  ["approval", "Approval"],
  ["checkpoint", "Checkpoint"],
] as const;

const ASSIGNEES = [
  ["employee", "Employee"],
  ["supervisor", "Supervisor"],
  ["manager", "Manager"],
  ["hr", "HR"],
  ["it", "IT"],
] as const;

// Every save goes through save_onboarding_template_step(): if employees have
// already been onboarded with the current version, the database first
// copies it to a new version, so their permanent records never change.
export function OnboardingStepForm({
  templateId,
  existingSteps,
  step,
  onDone,
  people = [],
  documents = [],
}: {
  templateId: string;
  existingSteps: { id: string; title: string }[];
  step?: TemplateStep;
  onDone?: () => void;
  // For HR/IT steps: an optional named owner, overriding the
  // organization's default owner for that kind of step.
  people?: { id: string; label: string }[];
  documents?: { id: string; title: string }[];
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
  const [fields, setFields] = useState(step?.form_schema?.fields ?? []),
    [reviewDocument, setReviewDocument] = useState(
      step?.review_document_id ?? "",
    );
  const namedOwnerAllowed =
    form.assignee_type === "hr" || form.assignee_type === "it";
  const [dependsOn, setDependsOn] = useState<string[]>(
    step?.dependency_step_ids ?? [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("save_onboarding_step", {
      p_template_id: templateId,
      p_step_id: step?.id ?? null,
      p_data: {
        ...form,
        due_offset_days: Number(form.due_offset_days || 0),
        phase: form.phase || null,
        assignee_employee_id: namedOwnerAllowed
          ? form.assignee_employee_id || null
          : null,
        dependency_step_ids: dependsOn,
        form_schema:
          form.step_type === "form" && fields.length ? { fields } : null,
        review_document_id: reviewDocument || null,
      },
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
          <label className="label" htmlFor={`step-title-${step?.id ?? "new"}`}>
            Title
          </label>
          <input
            id={`step-title-${step?.id ?? "new"}`}
            required
            maxLength={160}
            placeholder="e.g. Upload identification"
            className="input"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>
        <div className="sm:col-span-2">
          <label
            className="label"
            htmlFor={`step-description-${step?.id ?? "new"}`}
          >
            Instructions
          </label>
          <textarea
            id={`step-description-${step?.id ?? "new"}`}
            rows={2}
            maxLength={4000}
            className="input"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
        <div>
          <label className="label">Phase</label>
          <select
            className="input"
            value={form.phase}
            onChange={(e) => setForm({ ...form, phase: e.target.value })}
          >
            <option value="">No phase</option>
            {Object.entries(ONBOARDING_PHASE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Type</label>
          <select
            className="input"
            value={form.step_type}
            onChange={(e) => setForm({ ...form, step_type: e.target.value })}
          >
            {STEP_TYPES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Who completes it</label>
          <select
            className="input"
            value={form.assignee_type}
            onChange={(e) =>
              setForm({ ...form, assignee_type: e.target.value })
            }
          >
            {ASSIGNEES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {namedOwnerAllowed && people.length > 0 && (
          <div>
            <label className="label">Specific person (optional)</label>
            <select
              className="input"
              value={form.assignee_employee_id}
              onChange={(e) =>
                setForm({ ...form, assignee_employee_id: e.target.value })
              }
            >
              <option value="">
                Organization&apos;s {form.assignee_type.toUpperCase()} owner
              </option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-stone-600">
          <input
            type="checkbox"
            checked={form.required}
            onChange={(e) => setForm({ ...form, required: e.target.checked })}
          />{" "}
          Required to finish onboarding
        </label>
        <div>
          <label className="label">Due — days (negative = before)</label>
          <input
            type="number"
            min={-3660}
            max={3660}
            step={1}
            className="input"
            value={form.due_offset_days}
            onChange={(e) =>
              setForm({ ...form, due_offset_days: e.target.value })
            }
          />
        </div>
        <div>
          <label className="label">Relative to</label>
          <select
            className="input"
            value={form.due_anchor}
            onChange={(e) => setForm({ ...form, due_anchor: e.target.value })}
          >
            {Object.entries(DUE_ANCHOR_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label.charAt(0).toUpperCase() + label.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <p className="text-xs text-stone-500 sm:col-span-2">
          Due:{" "}
          {describeDueOffset(
            form.due_anchor,
            Number(form.due_offset_days || 0),
          )}
          .
        </p>
      </div>
      {form.step_type === "form" && (
        <section className="space-y-3">
          <h3 className="font-semibold">Form questions</h3>
          <p className="text-sm">
            Add up to 20 questions. With no configured questions, the assignee
            submits a narrative note. Keep identity numbers, bank details and
            confidential HR assessments in the official employee record.
          </p>
          {fields.map((f, index) => (
            <div key={f.key} className="rounded-lg border p-3 space-y-2">
              <label className="label">
                Question
                <input
                  className="input"
                  required
                  maxLength={120}
                  value={f.label}
                  onChange={(e) =>
                    setFields(
                      fields.map((x, i) =>
                        i === index ? { ...x, label: e.target.value } : x,
                      ),
                    )
                  }
                />
              </label>
              <label className="label">
                Answer type
                <select
                  className="input"
                  value={f.type}
                  onChange={(e) =>
                    setFields(
                      fields.map((x, i) =>
                        i === index ? { ...x, type: e.target.value } : x,
                      ),
                    )
                  }
                >
                  <option value="text">Text</option>
                  <option value="date">Date</option>
                  <option value="number">Number</option>
                  <option value="checkbox">Confirmation checkbox</option>
                </select>
              </label>
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={f.required}
                  onChange={(e) =>
                    setFields(
                      fields.map((x, i) =>
                        i === index ? { ...x, required: e.target.checked } : x,
                      ),
                    )
                  }
                />
                Required
              </label>
              <button
                type="button"
                className="btn-secondary"
                disabled={loading}
                onClick={() => setFields(fields.filter((_, i) => i !== index))}
              >
                Remove question
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn-secondary"
            disabled={loading || fields.length >= 20}
            onClick={() =>
              setFields([
                ...fields,
                {
                  key:
                    "q_" + crypto.randomUUID().replaceAll("-", "").slice(0, 12),
                  label: "",
                  type: "text",
                  required: true,
                },
              ])
            }
          >
            Add question
          </button>
        </section>
      )}
      {["document_review", "acknowledgement", "signature"].includes(
        form.step_type,
      ) && (
        <label className="label">
          Company document to review (optional)
          <select
            className="input"
            value={reviewDocument}
            onChange={(e) => setReviewDocument(e.target.value)}
          >
            <option value="">Instructions only / separate HR process</option>
            {documents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
          <span className="field-help">
            The run preserves the version assigned at its start. An account
            attestation does not replace a formal contract signature.
          </span>
        </label>
      )}
      {candidates.length > 0 && (
        <div>
          <label className="label">Depends on (must be finished first)</label>
          <select
            multiple
            className="input h-24"
            value={dependsOn}
            onChange={(e) =>
              setDependsOn(Array.from(e.target.selectedOptions, (o) => o.value))
            }
          >
            {candidates.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading || !form.title.trim()}
          className="btn-primary"
        >
          {loading ? "Saving…" : step ? "Save step" : "Add step"}
        </button>
        {onDone && step && (
          <button type="button" className="btn-secondary" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
