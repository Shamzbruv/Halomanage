"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export type CompanyProfile = {
  name: string;
  legal_name: string | null;
  contact_email: string | null;
  phone_number: string | null;
  website_url: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  timezone: string;
  default_locale: string;
};

const LOCALES = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
];

// Ref: supabase/migrations/20260829142948_employee_experience_branding.sql —
// update_organization_profile(). Distinct from OrganizationPortalCard: this
// is the company's own record (legal name, contact, address) rather than
// what employees see on the sign-in page.
export function CompanyProfileForm({ organizationId, initial }: { organizationId: string; initial: CompanyProfile }) {
  const supabase = createClient();
  const router = useRouter();
  const [form, setForm] = useState({
    name: initial.name,
    legal_name: initial.legal_name ?? "",
    contact_email: initial.contact_email ?? "",
    phone_number: initial.phone_number ?? "",
    website_url: initial.website_url ?? "",
    address_line1: initial.address_line1 ?? "",
    address_line2: initial.address_line2 ?? "",
    city: initial.city ?? "",
    region: initial.region ?? "",
    postal_code: initial.postal_code ?? "",
    country_code: initial.country_code ?? "",
    timezone: initial.timezone,
    default_locale: initial.default_locale,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("update_organization_profile", {
      p_organization_id: organizationId,
      p_name: form.name,
      p_legal_name: form.legal_name || null,
      p_contact_email: form.contact_email || null,
      p_phone_number: form.phone_number || null,
      p_website_url: form.website_url || null,
      p_address_line1: form.address_line1 || null,
      p_address_line2: form.address_line2 || null,
      p_city: form.city || null,
      p_region: form.region || null,
      p_postal_code: form.postal_code || null,
      p_country_code: form.country_code || null,
      p_timezone: form.timezone,
      p_default_locale: form.default_locale,
    });

    if (rpcError) {
      setError(rpcError.message);
      setLoading(false);
      return;
    }

    setLoading(false);
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label" htmlFor="company-name">Company name</label><input id="company-name" required className="input" value={form.name} onChange={(e) => set("name", e.target.value)} /></div>
        <div><label className="label" htmlFor="company-legal-name">Legal name <span className="font-normal text-stone-500">(optional)</span></label><input id="company-legal-name" className="input" value={form.legal_name} onChange={(e) => set("legal_name", e.target.value)} /></div>
        <div><label className="label" htmlFor="company-email">Contact email</label><input id="company-email" type="email" className="input" value={form.contact_email} onChange={(e) => set("contact_email", e.target.value)} /></div>
        <div><label className="label" htmlFor="company-phone">Phone number</label><input id="company-phone" className="input" value={form.phone_number} onChange={(e) => set("phone_number", e.target.value)} /></div>
        <div className="col-span-2"><label className="label" htmlFor="company-website">Website</label><input id="company-website" type="url" placeholder="https://" className="input" value={form.website_url} onChange={(e) => set("website_url", e.target.value)} /></div>
        <div className="col-span-2"><label className="label" htmlFor="company-address1">Address line 1</label><input id="company-address1" className="input" value={form.address_line1} onChange={(e) => set("address_line1", e.target.value)} /></div>
        <div className="col-span-2"><label className="label" htmlFor="company-address2">Address line 2</label><input id="company-address2" className="input" value={form.address_line2} onChange={(e) => set("address_line2", e.target.value)} /></div>
        <div><label className="label" htmlFor="company-city">City</label><input id="company-city" className="input" value={form.city} onChange={(e) => set("city", e.target.value)} /></div>
        <div><label className="label" htmlFor="company-region">Region / state</label><input id="company-region" className="input" value={form.region} onChange={(e) => set("region", e.target.value)} /></div>
        <div><label className="label" htmlFor="company-postal">Postal code</label><input id="company-postal" className="input" value={form.postal_code} onChange={(e) => set("postal_code", e.target.value)} /></div>
        <div><label className="label" htmlFor="company-country">Country code <span className="font-normal text-stone-500">(ISO-2)</span></label><input id="company-country" maxLength={2} placeholder="US" className="input" value={form.country_code} onChange={(e) => set("country_code", e.target.value.toUpperCase())} /></div>
        <div><label className="label" htmlFor="company-timezone">Timezone <span className="font-normal text-stone-500">(IANA)</span></label><input id="company-timezone" placeholder="America/New_York" className="input" value={form.timezone} onChange={(e) => set("timezone", e.target.value)} /></div>
        <div>
          <label className="label" htmlFor="company-locale">Default language</label>
          <select id="company-locale" className="input" value={form.default_locale} onChange={(e) => set("default_locale", e.target.value)}>
            {LOCALES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </div>
      </div>
      {error && <p className="alert-error" role="alert">{error}</p>}
      {saved && !error && <p className="text-xs text-emerald-700" role="status">Company profile updated.</p>}
      <button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Save company profile"}</button>
    </form>
  );
}
