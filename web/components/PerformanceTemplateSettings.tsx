"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
export function PerformanceTemplateSettings({
  template,
}: {
  template: {
    id: string;
    name: string;
    description: string | null;
    is_active: boolean;
    rating_scale: { value: number; label: string }[];
  };
}) {
  const router = useRouter();
  const [name, setName] = useState(template.name),
    [description, setDescription] = useState(template.description ?? ""),
    [active, setActive] = useState(template.is_active),
    [scale, setScale] = useState(
      template.rating_scale.map((x) => `${x.value}: ${x.label}`).join("\n"),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const rating_scale = scale
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => {
          const at = x.indexOf(":");
          if (at < 1) throw new Error("Use one number: label per line.");
          return {
            value: Number(x.slice(0, at)),
            label: x.slice(at + 1).trim(),
          };
        });
      const { error } = await createClient()
        .from("appraisal_templates")
        .update({
          name,
          description: description || null,
          is_active: active,
          rating_scale,
        })
        .eq("id", template.id)
        .select("id")
        .single();
      if (error) throw error;
      router.refresh();
    } catch (e) {
      setError(
        (e as { message?: string }).message ?? "Unable to save template.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="space-y-3" onSubmit={submit}>
      <label className="label">
        Name
        <input
          required
          maxLength={120}
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
      </label>
      <label className="label">
        Description
        <textarea
          maxLength={3000}
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={busy}
        />
      </label>
      <label className="label">
        Rating options (one number: label per line)
        <textarea
          className="input"
          rows={6}
          value={scale}
          onChange={(e) => setScale(e.target.value)}
          disabled={busy}
        />
      </label>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          disabled={busy}
        />
        Active for new cycles
      </label>
      <p>
        Changes apply to future launches. Existing checkpoints retain their
        recorded questions, labels and scale.
      </p>
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
      <button className="btn-primary" disabled={busy}>
        {busy ? "Saving…" : "Save template settings"}
      </button>
    </form>
  );
}
