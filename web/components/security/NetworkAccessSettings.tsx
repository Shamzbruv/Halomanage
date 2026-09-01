"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";
import { Icon } from "@/components/Icon";

type Mode = "disabled" | "monitor" | "enforced";
type Range = { id: string; cidr: string; label: string | null; createdAt: string };
type Exemption = { id: string; label: string };
type Option = { id: string; label: string };

const BUILT_IN_ROLES = ["employee", "supervisor", "manager", "admin"] as const;

const MODE_COPY: Record<Mode, { title: string; description: string }> = {
  disabled: { title: "Off", description: "Sign-in and use are not restricted by network." },
  monitor: { title: "Monitor", description: "Nothing is blocked yet — every out-of-range attempt is logged, so you can verify your ranges before turning enforcement on." },
  enforced: { title: "Enforced", description: "Sign-in and ongoing use are restricted to the ranges below, for everyone who isn't exempt." },
};

// Ref: 20260901100000_network_access_control.sql. Two enforcement layers
// exist behind this one settings panel — a continuous app-layer check on
// every request, and a partial database-layer check for direct
// browser-to-Supabase calls — but an admin configuring this only needs to
// think about "who's exempt" and "which networks," so both share the same
// ranges/exemptions rows.
export function NetworkAccessSettings({
  organizationId,
  initialMode,
  ranges,
  exemptions,
  customRoles,
  employees,
}: {
  organizationId: string;
  initialMode: Mode;
  ranges: Range[];
  exemptions: Exemption[];
  customRoles: Option[];
  employees: Option[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [modeLoading, setModeLoading] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

  const [cidr, setCidr] = useState("");
  const [rangeLabel, setRangeLabel] = useState("");
  const [rangeLoading, setRangeLoading] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const [exemptionType, setExemptionType] = useState<"role" | "custom" | "employee">("role");
  const [exemptionTarget, setExemptionTarget] = useState<string>(BUILT_IN_ROLES[3]);
  const [exemptionLoading, setExemptionLoading] = useState(false);
  const [exemptionError, setExemptionError] = useState<string | null>(null);

  async function saveMode(next: Mode) {
    setModeLoading(true);
    setModeError(null);
    const { error } = await supabase.rpc("set_network_enforcement_mode", { p_organization_id: organizationId, p_mode: next });
    if (error) {
      setModeError(await resolveFunctionErrorMessage(error, "Could not update the network access mode."));
      setModeLoading(false);
      return;
    }
    setMode(next);
    setModeLoading(false);
    router.refresh();
  }

  async function addRange(event: React.FormEvent) {
    event.preventDefault();
    setRangeLoading(true);
    setRangeError(null);
    const { error } = await supabase.rpc("add_network_range", { p_organization_id: organizationId, p_cidr: cidr, p_label: rangeLabel || null });
    if (error) {
      setRangeError(await resolveFunctionErrorMessage(error, "Could not add that range."));
      setRangeLoading(false);
      return;
    }
    setCidr("");
    setRangeLabel("");
    setRangeLoading(false);
    router.refresh();
  }

  async function removeRange(id: string) {
    setRangeError(null);
    const { error } = await supabase.rpc("remove_network_range", { p_range_id: id });
    if (error) {
      setRangeError(await resolveFunctionErrorMessage(error, "Could not remove that range."));
      return;
    }
    router.refresh();
  }

  async function addExemption(event: React.FormEvent) {
    event.preventDefault();
    setExemptionLoading(true);
    setExemptionError(null);
    const args: Record<string, string | null> = { p_organization_id: organizationId, p_role: null, p_custom_role_id: null, p_employee_id: null };
    if (exemptionType === "role") args.p_role = exemptionTarget;
    else if (exemptionType === "custom") args.p_custom_role_id = exemptionTarget;
    else args.p_employee_id = exemptionTarget;

    const { error } = await supabase.rpc("add_network_exemption", args);
    if (error) {
      setExemptionError(await resolveFunctionErrorMessage(error, "Could not add that exemption."));
      setExemptionLoading(false);
      return;
    }
    setExemptionLoading(false);
    router.refresh();
  }

  async function removeExemption(id: string) {
    setExemptionError(null);
    const { error } = await supabase.rpc("remove_network_exemption", { p_exemption_id: id });
    if (error) {
      setExemptionError(await resolveFunctionErrorMessage(error, "Could not remove that exemption."));
      return;
    }
    router.refresh();
  }

  return (
    <section className="card space-y-6" aria-labelledby="network-access-title">
      <div>
        <span className="eyebrow">Network access</span>
        <h2 id="network-access-title" className="mt-1 text-lg font-semibold text-stone-900">Restrict sign-in to approved networks.</h2>
        <p className="mt-1 text-sm text-stone-500">Checked on every request, not just at sign-in. Add at least one range before switching to Enforced.</p>
      </div>

      <div>
        <p className="label mb-2">Mode</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {(Object.keys(MODE_COPY) as Mode[]).map((option) => (
            <button
              key={option}
              type="button"
              disabled={modeLoading}
              onClick={() => saveMode(option)}
              className={`rounded-xl border p-3 text-left transition ${mode === option ? "border-royal-700 bg-royal-50" : "border-stone-200 hover:border-stone-300"}`}
            >
              <span className="flex items-center justify-between text-sm font-semibold text-stone-900">
                {MODE_COPY[option].title}
                {mode === option && <Icon name="check" size={16} />}
              </span>
              <span className="mt-1 block text-xs text-stone-500">{MODE_COPY[option].description}</span>
            </button>
          ))}
        </div>
        {modeError && <p className="alert-error mt-2" role="alert">{modeError}</p>}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-stone-900">Approved ranges</h3>
          <ul className="mb-3 space-y-2">
            {ranges.length === 0 && <li className="text-sm text-stone-400">No ranges added yet.</li>}
            {ranges.map((range) => (
              <li key={range.id} className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2 text-sm">
                <span><code className="font-mono text-xs">{range.cidr}</code>{range.label ? ` — ${range.label}` : ""}</span>
                <button type="button" className="icon-button" aria-label={`Remove ${range.cidr}`} onClick={() => removeRange(range.id)}><Icon name="x" size={15} /></button>
              </li>
            ))}
          </ul>
          <form onSubmit={addRange} className="flex flex-wrap gap-2">
            <input required className="input flex-1" placeholder="203.0.113.0/24" value={cidr} onChange={(e) => setCidr(e.target.value)} aria-label="CIDR range" />
            <input className="input flex-1" placeholder="Label (optional)" value={rangeLabel} onChange={(e) => setRangeLabel(e.target.value)} aria-label="Range label" />
            <button type="submit" className="btn-secondary" disabled={rangeLoading}>{rangeLoading ? "Adding…" : "Add range"}</button>
          </form>
          {rangeError && <p className="alert-error mt-2" role="alert">{rangeError}</p>}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold text-stone-900">Exemptions</h3>
          <p className="mb-2 text-xs text-stone-500">Always allowed, regardless of network.</p>
          <ul className="mb-3 space-y-2">
            {exemptions.length === 0 && <li className="text-sm text-stone-400">No exemptions yet.</li>}
            {exemptions.map((exemption) => (
              <li key={exemption.id} className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2 text-sm">
                <span>{exemption.label}</span>
                <button type="button" className="icon-button" aria-label={`Remove exemption ${exemption.label}`} onClick={() => removeExemption(exemption.id)}><Icon name="x" size={15} /></button>
              </li>
            ))}
          </ul>
          <form onSubmit={addExemption} className="space-y-2">
            <div className="flex gap-2">
              <select
                className="input"
                value={exemptionType}
                onChange={(e) => {
                  const next = e.target.value as typeof exemptionType;
                  setExemptionType(next);
                  setExemptionTarget(next === "role" ? BUILT_IN_ROLES[3] : next === "custom" ? (customRoles[0]?.id ?? "") : (employees[0]?.id ?? ""));
                }}
              >
                <option value="role">Built-in role</option>
                <option value="custom" disabled={customRoles.length === 0}>Custom role</option>
                <option value="employee" disabled={employees.length === 0}>Employee</option>
              </select>
              <select className="input flex-1" value={exemptionTarget} onChange={(e) => setExemptionTarget(e.target.value)}>
                {exemptionType === "role" && BUILT_IN_ROLES.map((role) => <option key={role} value={role}>{role.charAt(0).toUpperCase() + role.slice(1)}</option>)}
                {exemptionType === "custom" && customRoles.map((role) => <option key={role.id} value={role.id}>{role.label}</option>)}
                {exemptionType === "employee" && employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.label}</option>)}
              </select>
            </div>
            <button type="submit" className="btn-secondary" disabled={exemptionLoading || !exemptionTarget}>{exemptionLoading ? "Adding…" : "Add exemption"}</button>
          </form>
          {exemptionError && <p className="alert-error mt-2" role="alert">{exemptionError}</p>}
        </div>
      </div>
    </section>
  );
}
