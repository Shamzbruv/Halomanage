"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export type PersonalInfo = {
  personal_email: string | null;
  personal_phone: string | null;
  date_of_birth: string | null;
  gender: string | null;
  marital_status: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  country_code: string | null;
  postal_code: string | null;
};

const SELF_EDITABLE: (keyof PersonalInfo)[] = [
  "personal_email", "personal_phone", "gender", "marital_status",
  "address_line1", "address_line2", "city", "region", "country_code", "postal_code",
];

// Protected PII in employee_private: readable/writable by the employee
// themself and by employee.manage (HR) — never by a supervisor or manager
// by default. mode="self" is the employee's own profile: date of birth is
// HR controlled (enforced by a database trigger, not only hidden here).
//
// Input ids match readiness item codes so setup blocker links land on
// the right field (date_of_birth, personal_email, personal_phone, home_address).
export function EmployeePersonalInfoForm({
  organizationId,
  employeeId,
  initial,
  mode = "hr",
}: {
  organizationId: string;
  employeeId: string;
  initial: Partial<PersonalInfo> | null;
  mode?: "hr" | "self";
}) {
  const supabase = createClient();
  const router = useRouter();
  const [form, setForm] = useState<Record<keyof PersonalInfo, string>>({
    personal_email: initial?.personal_email ?? "",
    personal_phone: initial?.personal_phone ?? "",
    date_of_birth: initial?.date_of_birth ?? "",
    gender: initial?.gender ?? "",
    marital_status: initial?.marital_status ?? "",
    address_line1: initial?.address_line1 ?? "",
    address_line2: initial?.address_line2 ?? "",
    city: initial?.city ?? "",
    region: initial?.region ?? "",
    country_code: initial?.country_code ?? "JM",
    postal_code: initial?.postal_code ?? "",
  });
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(key: keyof PersonalInfo, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const keys = mode === "self" ? SELF_EDITABLE : (Object.keys(form) as (keyof PersonalInfo)[]);
    const payload = Object.fromEntries(keys.map((key) => [key, form[key].trim() || null]));
    if (payload.country_code) payload.country_code = String(payload.country_code).toUpperCase();
    const { error: upsertError } = await supabase
      .from("employee_private")
      .upsert({ employee_id: employeeId, organization_id: organizationId, ...payload }, { onConflict: "employee_id" });
    if (upsertError) {
      setError(upsertError.message);
      setLoading(false);
      return;
    }
    setSaved(true);
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="personal_email">Personal email</label>
          <input id="personal_email" type="email" className="input" value={form.personal_email} onChange={(e) => set("personal_email", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="personal_phone">Personal phone</label>
          <input id="personal_phone" className="input" value={form.personal_phone} onChange={(e) => set("personal_phone", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="date_of_birth">Date of birth</label>
          <input id="date_of_birth" type="date" className="input" disabled={mode === "self"} value={form.date_of_birth} onChange={(e) => set("date_of_birth", e.target.value)} />
          {mode === "self" && <p className="mt-1 text-xs text-stone-500">Managed by HR — ask HR if it&apos;s wrong.</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="gender">Gender</label>
            <select id="gender" className="input" value={form.gender} onChange={(e) => set("gender", e.target.value)}>
              <option value="">Prefer not to say</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="non_binary">Non-binary</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="marital_status">Marital status</label>
            <select id="marital_status" className="input" value={form.marital_status} onChange={(e) => set("marital_status", e.target.value)}>
              <option value="">Not recorded</option>
              <option value="single">Single</option>
              <option value="married">Married</option>
              <option value="common_law">Common-law</option>
              <option value="divorced">Divorced</option>
              <option value="widowed">Widowed</option>
            </select>
          </div>
        </div>
      </div>

      <fieldset id="home_address" className="space-y-3">
        <legend className="text-xs font-semibold uppercase text-stone-400">Home address</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="address_line1">Address line 1</label>
            <input id="address_line1" className="input" value={form.address_line1} onChange={(e) => set("address_line1", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="address_line2">Address line 2</label>
            <input id="address_line2" className="input" value={form.address_line2} onChange={(e) => set("address_line2", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="city">City / town</label>
            <input id="city" className="input" value={form.city} onChange={(e) => set("city", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="region">Parish / region</label>
            <input id="region" className="input" placeholder="e.g. St. Andrew" value={form.region} onChange={(e) => set("region", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="country_code">Country code</label>
            <input id="country_code" className="input" maxLength={2} placeholder="JM" value={form.country_code} onChange={(e) => set("country_code", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="postal_code">Postal code</label>
            <input id="postal_code" className="input" value={form.postal_code} onChange={(e) => set("postal_code", e.target.value)} />
          </div>
        </div>
      </fieldset>

      {error && <p role="alert" className="alert-error">{error}</p>}
      {saved && !error && <p role="status" className="text-xs text-emerald-700">Saved.</p>}
      <button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Save personal information"}</button>
    </form>
  );
}
