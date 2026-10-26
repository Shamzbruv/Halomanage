"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
export function AppraisalSectionForm({
  templateId,
  nextSequence,
  initial,
}: {
  templateId: string;
  nextSequence: number;
  initial?: { id: string; title: string; sequence: number; is_active: boolean };
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initial?.title ?? ""),
    [sequence, setSequence] = useState(
      String(initial?.sequence ?? nextSequence),
    ),
    [active, setActive] = useState(initial?.is_active ?? true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const values = { title, sequence: Number(sequence), is_active: active },
        table = createClient().from("appraisal_sections");
      const { error } = initial
        ? await table.update(values).eq("id", initial.id).select("id").single()
        : await table
            .insert({ ...values, template_id: templateId })
            .select("id")
            .single();
      if (error) throw error;
      if (!initial) {
        setTitle("");
        setSequence(String(Number(sequence) + 1));
      }
      router.refresh();
    } catch (e) {
      setError(
        (e as { message?: string }).message ?? "Unable to save section.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <fieldset disabled={busy} className="space-y-3">
        <label className="label">
          {initial ? "Section title" : "New section"}
          <input
            required
            maxLength={160}
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="label">
          Order (choose an unused position)
          <input
            type="number"
            required
            min={1}
            max={32767}
            className="input"
            value={sequence}
            onChange={(e) => setSequence(e.target.value)}
          />
        </label>
        {initial && (
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            Include section in future launches
          </label>
        )}
      </fieldset>
      {error && (
        <p className="alert-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn-secondary" disabled={busy}>
        {busy ? "Saving…" : initial ? "Save future section" : "Add section"}
      </button>
    </form>
  );
}
