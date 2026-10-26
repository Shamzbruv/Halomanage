"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type {
  PerformanceCheckpoint,
  PerformanceReviewer,
} from "@/lib/performance";
export function AppraisalReviewForm({
  checkpoint,
  reviewer,
}: {
  checkpoint: PerformanceCheckpoint;
  reviewer: PerformanceReviewer;
}) {
  const router = useRouter(),
    submitting = useRef(false),
    retry = useRef<{ payload: string; key: string } | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>(() =>
      Object.fromEntries(
        checkpoint.responses
          .filter((r) => r.reviewer_id === reviewer.id)
          .map((r) => [r.question_id, r.response_json]),
      ),
    ),
    [version, setVersion] = useState(reviewer.draft_version),
    [busy, setBusy] = useState(""),
    [error, setError] = useState<string | null>(null),
    [message, setMessage] = useState("");
  async function save(submit: boolean) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(submit ? "submit" : "save");
    setError(null);
    setMessage("");
    const payload = JSON.stringify([values, version, submit]);
    if (retry.current?.payload !== payload)
      retry.current = { payload, key: crypto.randomUUID() };
    try {
      const { data, error } = await createClient().rpc(
        "save_appraisal_review",
        {
          p_reviewer_id: reviewer.id,
          p_answers: values,
          p_expected_version: version,
          p_client_request_id: retry.current.key,
          p_submit: submit,
        },
      );
      if (error) throw error;
      setVersion(data.draft_version);
      retry.current = null;
      setMessage(
        submit
          ? "Review submitted."
          : "Draft saved. It remains private to you until submission.",
      );
      router.refresh();
    } catch (error) {
      setError(
        (error as { message?: string }).message ??
          "Unable to save. Keep your local text and reload only after checking your saved draft.",
      );
    } finally {
      submitting.current = false;
      setBusy("");
    }
  }
  const change = (id: string, value: unknown) =>
    setValues((v) => ({ ...v, [id]: value }));
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save(true);
      }}
    >
      <p className="text-sm">
        Your draft is private. Submission is final; add a shared follow-up after
        release if a correction is needed. Use evidence from the review period
        and explain support needs in the relevant text questions.
      </p>
      <fieldset disabled={!!busy} className="space-y-5">
        {checkpoint.form_snapshot.sections.map((s) => (
          <section key={s.id} className="space-y-3">
            <h3 className="font-semibold">{s.title}</h3>
            {s.questions.map((q) => {
              const val = values[q.id],
                goal =
                  val && typeof val === "object"
                    ? (val as Record<string, string>)
                    : {};
              return (
                <div key={q.id} className="space-y-2">
                  <label className="label" htmlFor={`answer-${q.id}`}>
                    {q.prompt}
                    {q.required ? " *" : " (optional)"}
                  </label>
                  {q.question_type === "rating_scale" ? (
                    <select
                      id={`answer-${q.id}`}
                      required={q.required}
                      className="input"
                      value={
                        val === undefined || val === null ? "" : String(val)
                      }
                      onChange={(e) =>
                        change(
                          q.id,
                          e.target.value === "" ? null : Number(e.target.value),
                        )
                      }
                    >
                      <option value="">Choose a rating</option>
                      {checkpoint.form_snapshot.rating_scale.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.value} — {r.label}
                        </option>
                      ))}
                    </select>
                  ) : q.question_type === "numeric_rating" ? (
                    <input
                      id={`answer-${q.id}`}
                      className="input"
                      type="number"
                      step="0.01"
                      required={q.required}
                      min={(q.options as { min?: number })?.min ?? 1}
                      max={(q.options as { max?: number })?.max ?? 5}
                      value={
                        val === undefined || val === null ? "" : String(val)
                      }
                      onChange={(e) =>
                        change(
                          q.id,
                          e.target.value === "" ? null : Number(e.target.value),
                        )
                      }
                    />
                  ) : q.question_type === "yes_no" ? (
                    <select
                      id={`answer-${q.id}`}
                      required={q.required}
                      className="input"
                      value={
                        val === undefined || val === null ? "" : String(val)
                      }
                      onChange={(e) =>
                        change(
                          q.id,
                          e.target.value === ""
                            ? null
                            : e.target.value === "true",
                        )
                      }
                    >
                      <option value="">Choose</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  ) : q.question_type === "multiple_choice" ? (
                    <select
                      id={`answer-${q.id}`}
                      required={q.required}
                      className="input"
                      value={String(val ?? "")}
                      onChange={(e) => change(q.id, e.target.value || null)}
                    >
                      <option value="">Choose</option>
                      {((q.options as string[]) ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : q.question_type === "goal" ? (
                    <fieldset className="rounded-xl border p-3 space-y-2">
                      <legend>Measurable goal</legend>
                      {[
                        ["title", "Goal title", 200],
                        ["measure", "How success will be measured", 2000],
                        ["target_date", "Target date", 20],
                        ["support", "Support needed (optional)", 2000],
                      ].map(([key, label, max]) => (
                        <label key={key} className="label">
                          {label}
                          <input
                            id={key === "title" ? `answer-${q.id}` : undefined}
                            className="input"
                            type={key === "target_date" ? "date" : "text"}
                            required={q.required && key !== "support"}
                            maxLength={Number(max)}
                            value={goal[String(key)] ?? ""}
                            onChange={(e) => {
                              const next = { ...goal, [key]: e.target.value };
                              change(
                                q.id,
                                Object.values(next).some((v) => v.trim())
                                  ? next
                                  : null,
                              );
                            }}
                          />
                        </label>
                      ))}
                    </fieldset>
                  ) : (
                    <textarea
                      id={`answer-${q.id}`}
                      className="input"
                      rows={4}
                      required={q.required}
                      maxLength={4000}
                      value={String(val ?? "")}
                      onChange={(e) => change(q.id, e.target.value || null)}
                    />
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </fieldset>
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="flex gap-3">
        <button
          type="button"
          className="btn-secondary"
          disabled={!!busy}
          onClick={() => void save(false)}
        >
          {busy === "save" ? "Saving…" : "Save draft"}
        </button>
        <button className="btn-primary" disabled={!!busy}>
          {busy === "submit" ? "Submitting…" : "Submit final review"}
        </button>
      </div>
    </form>
  );
}
