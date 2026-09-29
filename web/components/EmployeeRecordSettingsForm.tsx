"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Numbering = { mode: "automatic" | "manual"; prefix: string; padding: number; next_sequence: number; allow_manual_override: boolean };
type Requirements = Record<(typeof REQUIREMENTS)[number]["key"], boolean>;

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
}: {
  organizationId: string;
  numbering: Numbering;
  requirements: Requirements;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [num, setNum] = useState(numbering);
  const [req, setReq] = useState(requirements);
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
      p_requirements: req,
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
      </section>

      {error && <p role="alert" className="alert-error">{error}</p>}
      {saved && !error && <p role="status" className="text-sm text-emerald-700">Settings saved.</p>}
      <button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Save settings"}</button>
    </form>
  );
}
