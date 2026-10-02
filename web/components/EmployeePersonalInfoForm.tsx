"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { COUNTRIES, JAMAICA_PARISHES } from "@/lib/countries";
import { formatPhone } from "@/lib/phone";

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

// Exactly the columns this form reads or writes — never select("*") for
// employee_private (data minimization: the page gets only what it shows).
export const PERSONAL_INFO_COLUMNS =
  "personal_email, personal_phone, date_of_birth, gender, marital_status, address_line1, address_line2, city, region, country_code, postal_code";

export type CollectionSetting = "off" | "optional";

const SELF_EDITABLE: (keyof PersonalInfo)[] = [
  "personal_email", "personal_phone", "gender", "marital_status",
  "address_line1", "address_line2", "city", "region", "country_code", "postal_code",
];

// "Prefer not to say" is an answer and is stored as one; a blank means the
// question simply hasn't been answered — reports need to tell them apart.
const GENDER_OPTIONS = [
  ["female", "Female"], ["male", "Male"], ["non_binary", "Non-binary"], ["other", "Other"], ["prefer_not_to_say", "Prefer not to say"],
] as const;
const MARITAL_OPTIONS = [
  ["single", "Single"], ["married", "Married"], ["common_law", "Common-law"], ["divorced", "Divorced"], ["widowed", "Widowed"], ["prefer_not_to_say", "Prefer not to say"],
] as const;

// Protected PII in employee_private: the employee themself and
// employee.manage (HR) — never a supervisor or manager by default.
// mode="self" is the employee's own profile: date of birth is HR controlled
// (enforced by a database trigger, not only hidden here).
//
// Input ids match readiness item codes so setup links land on the field.
export function EmployeePersonalInfoForm({
  organizationId,
  employeeId,
  initial,
  mode = "hr",
  collectGender = "optional",
  collectMaritalStatus = "optional",
}: {
  organizationId: string;
  employeeId: string;
  initial: Partial<PersonalInfo> | null;
  mode?: "hr" | "self";
  collectGender?: CollectionSetting;
  collectMaritalStatus?: CollectionSetting;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [form, setForm] = useState<Record<keyof PersonalInfo, string>>({
    personal_email: initial?.personal_email ?? "",
    personal_phone: formatPhone(initial?.personal_phone),
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

  // A field the organization doesn't collect stays hidden — unless a value
  // is already on file, which HR (or the employee) should be able to see
  // and clear.
  const showGender = collectGender !== "off" || !!initial?.gender;
  const showMarital = collectMaritalStatus !== "off" || !!initial?.marital_status;
  const jamaica = form.country_code === "JM";

  function set(key: keyof PersonalInfo, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const keys = (mode === "self" ? SELF_EDITABLE : (Object.keys(form) as (keyof PersonalInfo)[]))
      .filter((key) => (key !== "gender" || showGender) && (key !== "marital_status" || showMarital));
    const payload = Object.fromEntries(keys.map((key) => [key, form[key].trim() || null]));
    if (jamaica) payload.postal_code = null;
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
          <input id="personal_phone" type="tel" className="input" placeholder="+1 (876) 555-1234" value={form.personal_phone} onChange={(e) => set("personal_phone", e.target.value)} />
        </div>
        {mode === "hr" && (
          <div>
            <label className="label" htmlFor="date_of_birth">Date of birth</label>
            <input id="date_of_birth" type="date" className="input" value={form.date_of_birth} onChange={(e) => set("date_of_birth", e.target.value)} />
          </div>
        )}
        {(showGender || showMarital) && (
          <div className="grid grid-cols-2 gap-3">
            {showGender && (
              <div>
                <label className="label" htmlFor="gender">Gender{collectGender === "off" && <span className="font-normal text-stone-400"> (no longer collected)</span>}</label>
                <select id="gender" className="input" value={form.gender} onChange={(e) => set("gender", e.target.value)}>
                  <option value="">Not provided</option>
                  {GENDER_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
            )}
            {showMarital && (
              <div>
                <label className="label" htmlFor="marital_status">Marital status{collectMaritalStatus === "off" && <span className="font-normal text-stone-400"> (no longer collected)</span>}</label>
                <select id="marital_status" className="input" value={form.marital_status} onChange={(e) => set("marital_status", e.target.value)}>
                  <option value="">Not provided</option>
                  {MARITAL_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
            )}
          </div>
        )}
      </div>

      <fieldset id="home_address" className="space-y-3">
        <legend className="text-xs font-semibold uppercase text-stone-400">Home address</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="country_code">Country</label>
            <select id="country_code" className="input" value={form.country_code} onChange={(e) => set("country_code", e.target.value)}>
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="address_line1">Address line 1</label>
            <input id="address_line1" className="input" autoComplete="address-line1" value={form.address_line1} onChange={(e) => set("address_line1", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="address_line2">Address line 2</label>
            <input id="address_line2" className="input" autoComplete="address-line2" value={form.address_line2} onChange={(e) => set("address_line2", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="city">{jamaica ? "Town / community" : "City"}</label>
            <input id="city" className="input" value={form.city} onChange={(e) => set("city", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="region">{jamaica ? "Parish" : "State / province / region"}</label>
            {jamaica ? (
              <select id="region" className="input" value={form.region} onChange={(e) => set("region", e.target.value)}>
                <option value="">Choose a parish</option>
                {!JAMAICA_PARISHES.includes(form.region) && form.region && <option value={form.region}>{form.region}</option>}
                {JAMAICA_PARISHES.map((parish) => <option key={parish} value={parish}>{parish}</option>)}
              </select>
            ) : (
              <input id="region" className="input" value={form.region} onChange={(e) => set("region", e.target.value)} />
            )}
          </div>
          {!jamaica && (
            <div>
              <label className="label" htmlFor="postal_code">Postal / ZIP code</label>
              <input id="postal_code" className="input" autoComplete="postal-code" value={form.postal_code} onChange={(e) => set("postal_code", e.target.value)} />
            </div>
          )}
        </div>
      </fieldset>

      {error && <p role="alert" className="alert-error">{error}</p>}
      {saved && !error && <p role="status" className="text-xs text-emerald-700">Saved.</p>}
      <button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Save personal information"}</button>
    </form>
  );
}
