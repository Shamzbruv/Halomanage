"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const POLICIES = [
  { value: "optional", label: "Optional for everyone", help: "Anyone can turn it on in Settings." },
  { value: "admins", label: "Required for administrators", help: "People who manage employees, roles, payroll or organization settings." },
  { value: "managers_and_admins", label: "Required for managers and administrators", help: "Adds anyone who can see a team or approve their leave." },
  { value: "everyone", label: "Required for everyone", help: "Every employee sets up an authenticator app." },
] as const;

// organization_security_policies via update_security_policy(). The
// requirement is enforced twice: the portal sends affected people to /mfa
// until their session is verified, and database triggers refuse sensitive
// writes (roles, compensation, payroll and employee imports, security
// settings, ending employment) from an unverified session.
export function SecurityPolicyForm({
  organizationId,
  initialPolicy,
  initialStepUp,
  currentAal,
  hasMfa,
}: {
  organizationId: string;
  initialPolicy: string;
  initialStepUp: boolean;
  currentAal: string;
  hasMfa: boolean;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [policy, setPolicy] = useState(initialPolicy);
  const [stepUp, setStepUp] = useState(initialStepUp);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    const { error: rpcError } = await supabase.rpc("update_security_policy", {
      p_organization_id: organizationId, p_mfa_policy: policy, p_step_up_for_sensitive_actions: stepUp,
    });
    if (rpcError) setError(rpcError.message);
    else {
      setMessage("Security policy saved.");
      router.refresh();
    }
    setLoading(false);
  }

  const tightening = policy !== "optional" || stepUp;
  return (
    <form onSubmit={save} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="label">Multi-factor authentication</legend>
        {POLICIES.map((p) => (
          <label key={p.value} className="flex items-start gap-2 rounded-lg border border-stone-100 p-2.5 text-sm text-stone-700">
            <input type="radio" name="mfa-policy" className="mt-0.5" value={p.value} checked={policy === p.value} onChange={() => setPolicy(p.value)} />
            <span>{p.label}<small className="block text-xs text-stone-500">{p.help}</small></span>
          </label>
        ))}
      </fieldset>
      <label className="flex items-start gap-2 rounded-lg border border-stone-100 p-2.5 text-sm text-stone-700">
        <input type="checkbox" className="mt-0.5" checked={stepUp} onChange={(e) => setStepUp(e.target.checked)} />
        <span>Require MFA verification for sensitive actions<small className="block text-xs text-stone-500">Changing roles or permissions, compensation, payroll and employee imports, security settings, and ending someone&apos;s employment — even when MFA is otherwise optional.</small></span>
      </label>
      {tightening && !hasMfa && (
        <p className="alert-warning">You haven&apos;t set up MFA yourself. After saving, you&apos;ll be asked to set it up before you can make sensitive changes. Set it up first in Settings to avoid interruption.</p>
      )}
      {currentAal !== "aal2" && initialStepUp && (
        <p className="text-xs text-stone-600">Changing this policy is itself a sensitive action — verify with your authenticator first if saving is refused.</p>
      )}
      {error && <p role="alert" className="alert-error">{error}</p>}
      {message && !error && <p role="status" className="text-xs text-emerald-700">{message}</p>}
      <button type="submit" className="btn-primary" disabled={loading}>{loading ? "Saving…" : "Save security policy"}</button>
    </form>
  );
}
