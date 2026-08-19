"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Question = { id: string; prompt: string; question_type: string; sequence: number };
type Section = { id: string; title: string; sequence: number; questions: Question[] };
type RatingOption = { value: number; label: string };

export function AppraisalReviewForm({
  instanceId,
  reviewerId,
  sections,
  ratingScale,
  existingResponses,
}: {
  instanceId: string;
  reviewerId: string;
  sections: Section[];
  ratingScale: RatingOption[];
  existingResponses: Record<string, { response_text: string | null; response_numeric: number | null }>;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [qid, r] of Object.entries(existingResponses)) {
      initial[qid] = r.response_numeric !== null ? String(r.response_numeric) : (r.response_text ?? "");
    }
    return initial;
  });
  const [loading, setLoading] = useState<"save" | "submit" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function set(qid: string, value: string) {
    setValues((v) => ({ ...v, [qid]: value }));
  }

  async function saveResponses() {
    const rows = sections.flatMap((s) =>
      s.questions
        .filter((q) => values[q.id] !== undefined && values[q.id] !== "")
        .map((q) => {
          const isNumeric = q.question_type === "rating_scale" || q.question_type === "numeric_rating";
          return {
            instance_id: instanceId,
            reviewer_id: reviewerId,
            question_id: q.id,
            response_numeric: isNumeric ? Number(values[q.id]) : null,
            response_text: isNumeric ? null : values[q.id],
          };
        }),
    );
    if (rows.length === 0) return true;
    const { error } = await supabase.from("appraisal_responses").upsert(rows, { onConflict: "reviewer_id,question_id" });
    if (error) {
      setError(error.message);
      return false;
    }
    return true;
  }

  async function handleSave() {
    setLoading("save");
    setError(null);
    const ok = await saveResponses();
    setLoading(null);
    if (ok) router.refresh();
  }

  async function handleSubmit() {
    setLoading("submit");
    setError(null);
    const ok = await saveResponses();
    if (!ok) {
      setLoading(null);
      return;
    }
    const { error } = await supabase.rpc("submit_appraisal", { p_instance_id: instanceId });
    if (error) {
      setError(error.message);
      setLoading(null);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {sections.map((s) => (
        <div key={s.id}>
          <h3 className="mb-2 text-sm font-semibold text-stone-900">{s.title}</h3>
          <div className="space-y-3">
            {s.questions.map((q) => (
              <div key={q.id}>
                <label className="label">{q.prompt}</label>
                {q.question_type === "rating_scale" && (
                  <select className="input" value={values[q.id] ?? ""} onChange={(e) => set(q.id, e.target.value)}>
                    <option value="">Select…</option>
                    {ratingScale.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                )}
                {q.question_type === "numeric_rating" && (
                  <input type="number" className="input" value={values[q.id] ?? ""} onChange={(e) => set(q.id, e.target.value)} />
                )}
                {q.question_type === "yes_no" && (
                  <select className="input" value={values[q.id] ?? ""} onChange={(e) => set(q.id, e.target.value)}>
                    <option value="">Select…</option>
                    <option value="Yes">Yes</option>
                    <option value="No">No</option>
                  </select>
                )}
                {(q.question_type === "text" || q.question_type === "goal") && (
                  <textarea className="input" rows={2} value={values[q.id] ?? ""} onChange={(e) => set(q.id, e.target.value)} />
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {error && <p className="alert-error">{error}</p>}

      <div className="flex gap-2">
        <button className="btn-secondary" disabled={!!loading} onClick={handleSave}>
          {loading === "save" ? "Saving…" : "Save draft"}
        </button>
        <button className="btn-primary" disabled={!!loading} onClick={handleSubmit}>
          {loading === "submit" ? "Submitting…" : "Submit review"}
        </button>
      </div>
    </div>
  );
}
