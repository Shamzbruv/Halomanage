"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { PerformanceQuestion } from "@/lib/performance";
export function AppraisalQuestionForm({
  sectionId,
  nextSequence,
  initial,
}: {
  sectionId: string;
  nextSequence: number;
  initial?: PerformanceQuestion & { is_active?: boolean };
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState(initial?.prompt ?? ""),
    [type, setType] = useState(initial?.question_type ?? "text"),
    [options, setOptions] = useState(
      Array.isArray(initial?.options) ? initial.options.join("\n") : "",
    ),
    [min, setMin] = useState(
      String((initial?.options as { min?: number })?.min ?? 1),
    ),
    [max, setMax] = useState(
      String((initial?.options as { max?: number })?.max ?? 5),
    ),
    [weight, setWeight] = useState(String(initial?.weight ?? 1)),
    [required, setRequired] = useState(initial?.required ?? true),
    [active, setActive] = useState(initial?.is_active ?? true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const values = {
        prompt,
        question_type: type,
        options:
          type === "multiple_choice"
            ? options
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean)
            : type === "numeric_rating"
              ? { min: Number(min), max: Number(max) }
              : null,
        weight: Number(weight),
        required,
        is_active: active,
      };
      const query = createClient().from("appraisal_questions");
      const { error } = initial
        ? await query.update(values).eq("id", initial.id).select("id").single()
        : await query
            .insert({
              ...values,
              section_id: sectionId,
              sequence: nextSequence,
            })
            .select("id")
            .single();
      if (error) throw error;
      if (!initial) setPrompt("");
      router.refresh();
    } catch (e) {
      setError(
        (e as { message?: string }).message ?? "Unable to save question.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <fieldset disabled={busy} className="space-y-3">
        <label className="label">
          Question prompt
          <textarea
            required
            maxLength={2000}
            className="input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label className="label">
          Answer type
          <select
            className="input"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            {[
              "text",
              "rating_scale",
              "numeric_rating",
              "yes_no",
              "multiple_choice",
              "goal",
            ].map((t) => (
              <option key={t} value={t}>
                {t.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        {type === "multiple_choice" && (
          <label className="label">
            Choices (one per line, 2–20)
            <textarea
              required
              className="input"
              value={options}
              onChange={(e) => setOptions(e.target.value)}
            />
          </label>
        )}
        {type === "numeric_rating" && (
          <div className="flex gap-3">
            <label className="label">
              Minimum
              <input
                type="number"
                step="0.01"
                required
                className="input"
                value={min}
                onChange={(e) => setMin(e.target.value)}
              />
            </label>
            <label className="label">
              Maximum
              <input
                type="number"
                step="0.01"
                required
                className="input"
                value={max}
                onChange={(e) => setMax(e.target.value)}
              />
            </label>
          </div>
        )}
        <label className="label">
          Recorded weight
          <input
            type="number"
            min={0}
            max={100}
            step="0.01"
            required
            className="input"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
          />
        </label>
        <p className="text-sm">
          Weights are recorded with the question. HaloManage does not combine
          incompatible rating scales into an automatic ranking or pay decision.
        </p>
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
          />
          Required to submit
        </label>
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          Active for future launches
        </label>
      </fieldset>
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
      <button className="btn-secondary" disabled={busy}>
        {busy ? "Saving…" : initial ? "Save future question" : "Add question"}
      </button>
    </form>
  );
}
