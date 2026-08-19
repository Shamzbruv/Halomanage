"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type PrivateInfo = {
  personal_email: string | null;
  personal_phone: string | null;
  address_line1: string | null;
  city: string | null;
  country_code: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
};

// employee_private RLS lets an employee insert/update only their own row
// (20260818000400_authorization.sql), so this same upsert works whether a
// row exists yet or not.
export function PrivateInfoForm({
  organizationId,
  employeeId,
  initial,
}: {
  organizationId: string;
  employeeId: string;
  initial: Partial<PrivateInfo>;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [form, setForm] = useState<PrivateInfo>({
    personal_email: initial.personal_email ?? "",
    personal_phone: initial.personal_phone ?? "",
    address_line1: initial.address_line1 ?? "",
    city: initial.city ?? "",
    country_code: initial.country_code ?? "",
    emergency_contact_name: initial.emergency_contact_name ?? "",
    emergency_contact_phone: initial.emergency_contact_phone ?? "",
    emergency_contact_relationship: initial.emergency_contact_relationship ?? "",
  });
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof PrivateInfo>(key: K, value: PrivateInfo[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSaved(false);
    const payload = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v || null]));
    const { error } = await supabase
      .from("employee_private")
      .upsert({ employee_id: employeeId, organization_id: organizationId, ...payload }, { onConflict: "employee_id" });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setSaved(true);
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Personal email</label>
          <input type="email" className="input" value={form.personal_email ?? ""} onChange={(e) => set("personal_email", e.target.value)} />
        </div>
        <div>
          <label className="label">Personal phone</label>
          <input className="input" value={form.personal_phone ?? ""} onChange={(e) => set("personal_phone", e.target.value)} />
        </div>
        <div>
          <label className="label">Address</label>
          <input className="input" value={form.address_line1 ?? ""} onChange={(e) => set("address_line1", e.target.value)} />
        </div>
        <div>
          <label className="label">City</label>
          <input className="input" value={form.city ?? ""} onChange={(e) => set("city", e.target.value)} />
        </div>
        <div>
          <label className="label">Country code</label>
          <input className="input" placeholder="JM" value={form.country_code ?? ""} onChange={(e) => set("country_code", e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="label">Emergency contact</label>
          <input className="input" value={form.emergency_contact_name ?? ""} onChange={(e) => set("emergency_contact_name", e.target.value)} />
        </div>
        <div>
          <label className="label">Their phone</label>
          <input className="input" value={form.emergency_contact_phone ?? ""} onChange={(e) => set("emergency_contact_phone", e.target.value)} />
        </div>
        <div>
          <label className="label">Relationship</label>
          <input className="input" value={form.emergency_contact_relationship ?? ""} onChange={(e) => set("emergency_contact_relationship", e.target.value)} />
        </div>
      </div>
      {error && <p className="alert-error">{error}</p>}
      {saved && !error && <p className="text-xs text-emerald-700">Saved.</p>}
      <button type="submit" disabled={loading} className="btn-primary">
        {loading ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
