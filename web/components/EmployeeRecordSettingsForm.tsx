"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Numbering = { mode: "automatic" | "manual"; prefix: string; padding: number; next_sequence: number; allow_manual_override: boolean };
type Requirements = Record<(typeof REQUIREMENTS)[number]["key"], boolean>;
export type ProfileSettings = {
  collect_gender: "off" | "optional";
  collect_marital_status: "off" | "optional";
  work_phone_editable_by_employee: boolean;
  privacy_notice_url: string;
};

const REQUIREMENTS = [
  { key: "require_reporting_line", label: "Supervisor or manager", help: "Someone the new hire reports to." },
  { key: "require_onboarding_plan", label: "Onboarding plan", help: "A plan selected before access is issued." },
  { key: "require_date_of_birth", label: "Date of birth", help: "" },
  { key: "require_trn", label: "TRN (Tax Registration Number)", help: "Recorded under Government IDs." },
  { key: "require_personal_email", label: "Personal email", help: "" },
  { key: "require_personal_phone", label: "Personal phone", help: "" },
  { key: "require_home_address", label: "Home address", help: "Address line and city." },
  { key: "require_emergency_contact", label: "Emergency contact", help: "At least one contact." },
] as const;

function formatNumber(prefix: string, padding: number, sequence: number) {
  const digits = String(sequence);
  return prefix + (digits.length >= padding ? digits : digits.padStart(padding, "0"));
}

// Writes through update_employee_record_settings() (audited). Identity,
// employment and portal-access items are always required before an
// invitation; the checkboxes here add organization-specific requirements.
export function EmployeeRecordSettingsForm({
  organizationId,
  numbering,
  requirements,
  profile,
}: {
  organizationId: string;
  numbering: Numbering;
  requirements: Requirements;
  profile: ProfileSettings;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [num, setNum] = useState(numbering);
  const [req, setReq] = useState(requirements);
  const [prof, setProf] = useState(profile);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setSaved(false);
    const { error: rpcError } = await supabase.rpc("update_employee_record_settings", {
      p_organization_id: organizationId,
      p_numbering: num,
      p_requirements: { ...req, ...prof, privacy_notice_url: prof.privacy_notice_url.trim() },
    });
    if (rpcError) {
      setError(rpcError.message);
    } else {
      setSaved(true);
      router.refresh();
    }
    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <section className="card space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-stone-900">Employee numbers</h2>
          <p className="text-xs text-stone-500">New employees are numbered automatically in the database, so two administrators adding people at the same time can never receive the same number. Numbers imported through the Migration Center are always kept exactly as they are.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="numbering-mode">Numbering</label>
            <select id="numbering-mode" className="input" value={num.mode} onChange={(e) => setNum({ ...num, mode: e.target.value as Numbering["mode"] })}>
              <option value="automatic">Automatic — HaloManage generates the next number</option>
              <option value="manual">Manual — HR types every number</option>
            </select>
          </div>
          {num.mode === "automatic" && (
            <>
              <div>
                <label className="label" htmlFor="numbering-prefix">Prefix</label>
                <input id="numbering-prefix" className="input font-mono" maxLength={20} value={num.prefix} onChange={(e) => setNum({ ...num, prefix: e.target.value })} />
              </div>
              <div>
                <label className="label" htmlFor="numbering-padding">Minimum digits</label>
                <input id="numbering-padding" type="number" min={0} max={12} className="input" value={num.padding} onChange={(e) => setNum({ ...num, padding: Number(e.target.value) })} />
              </div>
              <div>
                <label className="label" htmlFor="numbering-next">Next number</label>
                <input id="numbering-next" type="number" min={0} className="input" value={num.next_sequence} onChange={(e) => setNum({ ...num, next_sequence: Number(e.target.value) })} />
                <p className="field-help">Numbers already in use are skipped automatically.</p>
              </div>
              <label className="flex items-center gap-2 text-sm text-stone-600 sm:col-span-2">
                <input type="checkbox" checked={num.allow_manual_override} onChange={(e) => setNum({ ...num, allow_manual_override: e.target.checked })} />
                Allow HR to keep an existing number from a previous system when adding someone by hand
              </label>
            </>
          )}
        </div>
        {num.mode === "automatic" && (
          <p className="text-sm text-stone-600">Next employee will be <strong className="font-mono">{formatNumber(num.prefix, num.padding, num.next_sequence)}</strong>.</p>
        )}
      </section>

      <section className="card space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-stone-900">Required before invitation</h2>
          <p className="text-xs text-stone-500">Always required: employee number, legal name, work email, hire date, employment type, department, position, location, and portal access. Choose what else your organization needs before someone gets access.</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {REQUIREMENTS.map((item) => (
            <label key={item.key} className="flex items-start gap-2 rounded-lg border border-stone-100 p-2.5 text-sm text-stone-700">
              <input type="checkbox" className="mt-0.5" checked={req[item.key]} onChange={(e) => setReq({ ...req, [item.key]: e.target.checked })} />
              <span>{item.label}{item.help && <small className="block text-xs text-stone-500">{item.help}</small>}</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-stone-500">These stay required after someone starts: the People directory&apos;s &ldquo;Profile incomplete&rdquo; view lists anyone who is missing them, and employees see what&apos;s missing on My Profile.</p>
      </section>

      <section className="card space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-stone-900">Personal information you collect</h2>
          <p className="text-xs text-stone-500">Collect only what you need and can explain. Fields that are off aren&apos;t shown to employees (values already on file stay visible so they can be reviewed or cleared).</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="collect-gender">Gender</label>
            <select id="collect-gender" className="input" value={prof.collect_gender} onChange={(e) => setProf({ ...prof, collect_gender: e.target.value as ProfileSettings["collect_gender"] })}>
              <option value="off">Not collected</option>
              <option value="optional">Optional for employees</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="collect-marital">Marital status</label>
            <select id="collect-marital" className="input" value={prof.collect_marital_status} onChange={(e) => setProf({ ...prof, collect_marital_status: e.target.value as ProfileSettings["collect_marital_status"] })}>
              <option value="off">Not collected</option>
              <option value="optional">Optional for employees</option>
            </select>
          </div>
          <label className="flex items-start gap-2 rounded-lg border border-stone-100 p-2.5 text-sm text-stone-700 sm:col-span-2">
            <input type="checkbox" className="mt-0.5" checked={prof.work_phone_editable_by_employee} onChange={(e) => setProf({ ...prof, work_phone_editable_by_employee: e.target.checked })} />
            <span>Employees can change their own work phone<small className="block text-xs text-stone-500">Leave off if work numbers are company-issued — then HR/IT manage them and employees request corrections.</small></span>
          </label>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="privacy-notice">Employee privacy notice (link)</label>
            <input id="privacy-notice" type="url" className="input" placeholder="https://…" value={prof.privacy_notice_url} onChange={(e) => setProf({ ...prof, privacy_notice_url: e.target.value })} />
            <p className="field-help">Shown to every employee under Privacy &amp; data on My Profile.</p>
          </div>
        </div>
      </section>

      {error && <p role="alert" className="alert-error">{error}</p>}
      {saved && !error && <p role="status" className="text-sm text-emerald-700">Settings saved.</p>}
      <button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Save settings"}</button>
    </form>
  );
}
