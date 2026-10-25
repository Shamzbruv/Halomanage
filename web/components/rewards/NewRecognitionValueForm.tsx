"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
export function NewRecognitionValueForm({
  organizationId,
  initial,
}: {
  organizationId: string;
  initial?: {
    id: string;
    name: string;
    description: string | null;
    is_active: boolean;
  };
}) {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [saved, setSaved] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      f = new FormData(form);
    setBusy(true);
    setError(null);
    setSaved(false);
    const { error } = await createClient().rpc("save_recognition_value", {
      p_organization_id: organizationId,
      p_value_id: initial?.id ?? null,
      p_name: String(f.get("name")),
      p_description: String(f.get("description")) || null,
      p_active: f.has("active"),
    });
    setBusy(false);
    if (error) setError(error.message);
    else {
      if (!initial) form.reset();
      setSaved(true);
      router.refresh();
    }
  }
  return (
    <details className="mt-3">
      <summary className="cursor-pointer font-semibold">
        {initial ? `Edit ${initial.name}` : "Add an organization value"}
      </summary>
      <form className="mt-3 space-y-3" onSubmit={submit}>
        <label className="block">
          Value name
          <input
            className="input"
            name="name"
            required
            maxLength={80}
            defaultValue={initial?.name ?? ""}
          />
        </label>
        <label className="block">
          What this means in practice
          <textarea
            className="input"
            name="description"
            maxLength={1000}
            rows={3}
            defaultValue={initial?.description ?? ""}
          />
        </label>
        <label className="block">
          <input
            type="checkbox"
            name="active"
            defaultChecked={initial?.is_active ?? true}
          />{" "}
          Available for new recognition
        </label>
        <p className="text-xs">
          Archive a value to stop new use. Historical recognition keeps the
          original value name.
        </p>
        {error && (
          <p className="alert-error" role="alert">
            {error}
          </p>
        )}
        {saved && <p role="status">Value saved.</p>}
        <button className="btn-secondary" disabled={busy}>
          {busy ? "Saving…" : "Save value"}
        </button>
      </form>
    </details>
  );
}
