"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";

export function LoginForm() {
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
      const { error: recoveryError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/update-password`,
      });
      if (recoveryError) setError(recoveryError.message);
      else setMessage("Check your email for a secure password reset link.");
      setLoading(false);
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setError("We couldn’t sign you in. Check your email and password, then try again.");
      setLoading(false);
      return;
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
      {!recoveryMode && <p className="auth-invite-note"><Icon name="shield" size={15} /> Employee accounts are created through a secure invitation from your HR team.</p>}
    </form>
  );
}
