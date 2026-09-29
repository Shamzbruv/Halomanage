"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export type OnboardingRecommendation = {
  template_id: string;
  template_name: string;
  reason: string;
  matched_on: string[];
} | null;

// HR chooses the plan; HaloManage only recommends it (from
// onboarding_templates.applies_to via recommend_onboarding_template()) and
// says so, rather than silently assigning something HR can't see. The
// selected plan starts automatically when the invitation creates the
// employee's account — so employee tasks always have a real assignee —
// unless HR starts it early for preboarding.
export function OnboardingTemplateRecommendation({
  employeeId,
  templates,
  recommendation,
  selectedTemplateId,
  wasRecommended,
  hasAccount,
  activeRun,
}: {
  employeeId: string;
  templates: { id: string; name: string }[];
  recommendation: OnboardingRecommendation;
  selectedTemplateId: string | null;
  wasRecommended: boolean;
  hasAccount: boolean;
  activeRun: { id: string; templateName: string } | null;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [value, setValue] = useState(selectedTemplateId ?? recommendation?.template_id ?? "");
  const [loading, setLoading] = useState<"save" | "start" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setLoading("save");
    setError(null);
    setMessage(null);
    const { error: rpcError } = await supabase.rpc("set_employee_onboarding_plan", {
      p_employee_id: employeeId,
      p_template_id: value || null,
      p_was_recommended: !!recommendation && value === recommendation.template_id,
    });
    if (rpcError) {
      setError(rpcError.message);
    } else {
      setMessage(hasAccount ? "Onboarding plan saved." : "Onboarding plan saved — it starts automatically when the invitation is sent.");
      router.refresh();
    }
    setLoading(null);
  }

  async function startNow() {
    if (!value) return;
    setLoading("start");
    setError(null);
    setMessage(null);
    const { error: planError } = await supabase.rpc("set_employee_onboarding_plan", {
      p_employee_id: employeeId,
      p_template_id: value,
      p_was_recommended: !!recommendation && value === recommendation.template_id,
    });
    const { error: startError } = planError
      ? { error: planError }
      : await supabase.rpc("start_onboarding", { p_employee_id: employeeId, p_template_id: value });
    if (startError) {
      setError(startError.message);
    } else {
      setMessage(hasAccount ? "Onboarding started." : "Preboarding started. Employee tasks will be assigned to them automatically once they accept the invitation.");
      router.refresh();
    }
    setLoading(null);
  }

  return (
    <div className="space-y-3" id="onboarding_plan">
      {recommendation && (
        <div className="recommendation-callout">
          <span className="badge badge-emerald">Recommended by HaloManage</span>
          <p><strong>{recommendation.template_name}</strong> — {recommendation.reason}.</p>
          {value !== recommendation.template_id && (
            <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setValue(recommendation.template_id)}>Use recommendation</button>
          )}
        </div>
      )}
      <div>
        <label className="label" htmlFor="onboarding-template">Onboarding plan</label>
        <select id="onboarding-template" className="input" value={value} onChange={(event) => setValue(event.target.value)}>
          <option value="">No onboarding plan</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}{recommendation?.template_id === template.id ? " (recommended)" : ""}
            </option>
          ))}
        </select>
        {selectedTemplateId && (
          <p className="field-help">
            Currently selected: {templates.find((t) => t.id === selectedTemplateId)?.name ?? "a template that is no longer active"}
            {wasRecommended ? " — HaloManage's recommendation." : "."}
          </p>
        )}
      </div>
      {activeRun && (
        <p className="text-xs text-stone-600">
          Onboarding already in progress: <Link className="text-royal-700 hover:underline" href={`/admin/onboarding/runs/${activeRun.id}`}>{activeRun.templateName}</Link>.
        </p>
      )}
      {error && <p role="alert" className="alert-error">{error}</p>}
      {message && !error && <p role="status" className="text-xs text-emerald-700">{message}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={loading !== null} onClick={save}>{loading === "save" ? "Saving…" : "Save plan"}</button>
        {!activeRun && value && (
          <button type="button" className="btn-secondary" disabled={loading !== null} onClick={startNow}>
            {loading === "start" ? "Starting…" : hasAccount ? "Start onboarding now" : "Start preboarding now"}
          </button>
        )}
      </div>
    </div>
  );
}
