"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";

export function LoginForm({ portal }: { portal?: { name: string; slug: string } }) {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    if (recoveryMode) {
      const recoveryDestination = portal ? `/update-password?portal=${encodeURIComponent(portal.slug)}` : "/update-password";
      const { error: recoveryError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(recoveryDestination)}`,
      });
      if (recoveryError) setError(recoveryError.message);
      else setMessage("Check your email for a secure password reset link.");
      setLoading(false);
      return;
    }

    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setError("We couldn’t sign you in. Check your email and password, then try again.");
      setLoading(false);
      return;
    }

    const user = signInData.user;
    const { data: employee, error: employeeError } = await supabase
      .from("employees")
      .select("organization_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (employeeError) {
      setError("Your password is correct, but Halomanage could not load your employee record. Please try again or contact your HR administrator.");
      setLoading(false);
      return;
    }

    if (!employee) {
      if (user.user_metadata?.signup_intent === "organization_owner") {
        router.push("/signup/complete?repair=1");
        router.refresh();
        return;
      }
      await supabase.auth.signOut();
      setError("This login is not connected to an employee record yet. Ask your HR administrator to resend or repair your invitation.");
      setLoading(false);
      return;
    }

    if (portal) {
      const { data: organization, error: organizationError } = await supabase
        .from("organizations")
        .select("slug")
        .eq("id", employee.organization_id)
        .maybeSingle();
      if (organizationError || String(organization?.slug) !== portal.slug) {
        await supabase.auth.signOut();
        setError(`This account is not connected to ${portal.name}. Use the employee portal link supplied by your organization.`);
        setLoading(false);
        return;
      }
    }

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="auth-form">
      {recoveryMode && (
        <button type="button" className="auth-back-link" onClick={() => { setRecoveryMode(false); setError(null); setMessage(null); }}>
          ← Back to sign in
        </button>
      )}
      <div>
        <label className="label" htmlFor="email">Work email</label>
        <input id="email" type="email" required autoComplete="email" className="input" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      {!recoveryMode && (
        <div>
          <label className="label" htmlFor="password">
            Password
            <button type="button" className="label-hint" onClick={() => { setRecoveryMode(true); setError(null); setMessage(null); }}>Forgot password?</button>
          </label>
          <input id="password" type="password" required autoComplete="current-password" className="input" placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      )}
      {error && <p role="alert" className="alert-error">{error}</p>}
      {message && <p role="status" className="alert-success">{message}</p>}
      <button type="submit" disabled={loading || Boolean(message)} className="btn-primary w-full">
        {loading ? "Please wait…" : recoveryMode ? "Send reset link" : <>Sign in <Icon name="arrow-right" size={16} /></>}
      </button>
      {!recoveryMode && <p className="auth-invite-note"><Icon name="shield" size={15} /> {portal ? `Only accounts invited by ${portal.name} can sign in here.` : "Employee accounts are created through a secure invitation from your HR team."}</p>}
    </form>
  );
}
