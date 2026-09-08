"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Icon } from "@/components/Icon";

export function AddCertificationForm({ organizationId, employeeId }: { organizationId: string; employeeId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [issuingBody, setIssuingBody] = useState("");
  const [issuedOn, setIssuedOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.from("certifications").insert({
      organization_id: organizationId,
      employee_id: employeeId,
      name,
      issuing_body: issuingBody || null,
      issued_on: issuedOn || null,
      expires_on: expiresOn || null,
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setName("");
    setIssuingBody("");
    setIssuedOn("");
    setExpiresOn("");
    setOpen(false);
    setLoading(false);
    router.refresh();
  }

  if (!open) {
    return <button type="button" className="btn-secondary text-xs" onClick={() => setOpen(true)}><Icon name="document" size={14} /> Add certification</button>;
  }

  return (
    <form onSubmit={handleSubmit} className="mt-2 space-y-2 rounded-lg border border-stone-200 p-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <label className="label">Name</label>
          <input required className="input" placeholder="First Aid & CPR" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="col-span-2">
          <label className="label">Issuing body</label>
          <input className="input" value={issuingBody} onChange={(e) => setIssuingBody(e.target.value)} />
        </div>
        <div>
          <label className="label">Issued on</label>
          <input type="date" className="input" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
        </div>
        <div>
          <label className="label">Expires on</label>
          <input type="date" className="input" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </div>
      </div>
      {error && <p className="alert-error">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Save"}</button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
