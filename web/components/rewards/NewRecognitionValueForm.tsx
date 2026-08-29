"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Icon } from "@/components/Icon";

export function NewRecognitionValueForm({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: insertError } = await supabase.from("recognition_values").insert({
      organization_id: organizationId,
      name,
      description: description || null,
    });
    if (insertError) {
      setError(insertError.message);
      setLoading(false);
      return;
    }
    setOpen(false);
    setLoading(false);
    setName("");
    setDescription("");
    router.refresh();
  }

  if (!open) {
    return <button type="button" className="btn-secondary" onClick={() => setOpen(true)}><Icon name="spark" size={16} /> New value</button>;
  }

  return (
    <div className="modal-layer" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="Close dialog" onClick={() => setOpen(false)} />
      <form onSubmit={handleSubmit} className="modal-card space-y-3" role="dialog" aria-modal="true" aria-labelledby="new-value-title">
        <div className="modal-head"><div><span className="eyebrow">Recognition</span><h3 id="new-value-title">New recognition value</h3></div><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setOpen(false)}><Icon name="x" size={18} /></button></div>
        <div><label className="label" htmlFor="value-name">Name</label><input id="value-name" required className="input" placeholder="Ownership" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className="label" htmlFor="value-description">Description</label><textarea id="value-description" className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        {error && <p className="alert-error">{error}</p>}
        <div className="flex gap-2"><button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Create"}</button><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </div>
  );
}
