"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Icon } from "@/components/Icon";

export type ProviderOption = { id: string; name: string; fulfillment_type: string };

export function NewRewardVendorForm({ organizationId, providers }: { organizationId: string; providers: ProviderOption[] }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [providerId, setProviderId] = useState(providers.find((p) => p.fulfillment_type === "manual")?.id ?? providers[0]?.id ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: insertError } = await supabase.from("reward_vendors").insert({
      organization_id: organizationId,
      provider_id: providerId,
      name,
      description: description || null,
      contact_name: contactName || null,
      contact_email: contactEmail || null,
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
    return <button type="button" className="btn-primary" onClick={() => setOpen(true)}><Icon name="people" size={16} /> New vendor</button>;
  }

  return (
    <div className="modal-layer" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="Close dialog" onClick={() => setOpen(false)} />
      <form onSubmit={handleSubmit} className="modal-card space-y-3" role="dialog" aria-modal="true" aria-labelledby="new-vendor-title">
        <div className="modal-head"><div><span className="eyebrow">Rewards catalog</span><h3 id="new-vendor-title">New reward vendor</h3><p>Any source of a reward — a local supplier, a gift card provider, an internal perk — is a vendor.</p></div><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setOpen(false)}><Icon name="x" size={18} /></button></div>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><label className="label" htmlFor="vendor-name">Name</label><input id="vendor-name" required className="input" placeholder="Fontana Pharmacy" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="col-span-2">
            <label className="label" htmlFor="vendor-provider">Fulfillment</label>
            <select id="vendor-provider" className="input" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.fulfillment_type === "manual" ? "manual" : "automatic API"})</option>)}
            </select>
          </div>
          <div><label className="label" htmlFor="vendor-contact-name">Contact name</label><input id="vendor-contact-name" className="input" value={contactName} onChange={(e) => setContactName(e.target.value)} /></div>
          <div><label className="label" htmlFor="vendor-contact-email">Contact email</label><input id="vendor-contact-email" type="email" className="input" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} /></div>
          <div className="col-span-2"><label className="label" htmlFor="vendor-description">Description</label><textarea id="vendor-description" className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        </div>
        {error && <p className="alert-error">{error}</p>}
        <div className="flex gap-2"><button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Create"}</button><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </div>
  );
}
