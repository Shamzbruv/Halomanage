"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// A provider row is metadata only — key, display name, and which
// fulfillment style it represents. Real API credentials for an
// automatic_api provider (Tremendous, Tango, Giftbit, ...) live only in
// Edge Function secrets, never here — this table is safe to expose to
// every signed-in org member (see reward_providers RLS).
export function NewRewardProviderForm() {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [fulfillmentType, setFulfillmentType] = useState<"manual" | "automatic_api">("automatic_api");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: insertError } = await supabase.from("reward_providers").insert({
      key: key.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
      name,
      fulfillment_type: fulfillmentType,
      is_active: false,
      notes: notes || null,
    });
    if (insertError) {
      setError(insertError.message);
      setLoading(false);
      return;
    }
    setOpen(false);
    setLoading(false);
    router.refresh();
  }

  if (!open) {
    return <button type="button" className="platform-btn platform-btn-primary" onClick={() => setOpen(true)}>New provider</button>;
  }

  return (
    <div className="modal-layer" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="Close dialog" onClick={() => setOpen(false)} />
      <form onSubmit={handleSubmit} className="modal-card space-y-3" role="dialog" aria-modal="true" aria-labelledby="new-provider-title">
        <div className="modal-head">
          <div>
            <span className="eyebrow">Rewards infrastructure</span>
            <h3 id="new-provider-title">New reward provider</h3>
            <p>Created inactive by default — activate it only once real API credentials exist in Edge Function secrets.</p>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="provider-key">Key</label>
          <input id="provider-key" required className="input" placeholder="tremendous" value={key} onChange={(e) => setKey(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="provider-name">Display name</label>
          <input id="provider-name" required className="input" placeholder="Tremendous" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="provider-type">Fulfillment type</label>
          <select id="provider-type" className="input" value={fulfillmentType} onChange={(e) => setFulfillmentType(e.target.value as "manual" | "automatic_api")}>
            <option value="automatic_api">Automatic (API-fulfilled)</option>
            <option value="manual">Manual</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="provider-notes">Notes</label>
          <textarea id="provider-notes" className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {error && <p className="alert-error">{error}</p>}
        <div className="flex gap-2"><button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Create"}</button><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </div>
  );
}
