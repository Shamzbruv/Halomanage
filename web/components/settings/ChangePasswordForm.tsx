"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const MIN_LENGTH = 8;

// Changing a password from Settings requires the current one. It is checked
// by verify_my_password() (bcrypt comparison in the database, rate-limited,
// no new session created) and also sent to Supabase as current_password.
// If the project ever requires reauthentication, Supabase emails a code
// and this form asks for it. The recovery-link flow (/update-password) is
// separate: someone who forgot their password can't type the old one.
export function ChangePasswordForm() {
  const supabase = createClient();
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [nonce, setNonce] = useState("");
  const [needsNonce, setNeedsNonce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (password.length < MIN_LENGTH) return setError(`Use at least ${MIN_LENGTH} characters.`);
    if (password !== confirmation) return setError("The new passwords don't match.");
    if (password === current) return setError("Choose a password different from your current one.");

    setLoading(true);
    if (!needsNonce) {
      const { data: valid, error: verifyError } = await supabase.rpc("verify_my_password", { p_password: current });
      if (verifyError || !valid) {
        setError(verifyError?.message ?? "Your current password is incorrect.");
        setLoading(false);
        return;
      }
    }

    const { error: updateError } = await supabase.auth.updateUser({
      password,
      current_password: current,
      ...(needsNonce ? { nonce: nonce.trim() } : {}),
    });
    if (updateError) {
      if (updateError.code === "reauthentication_needed" || /reauthenticat/i.test(updateError.message)) {
        await supabase.auth.reauthenticate();
        setNeedsNonce(true);
        setError("For your security, we've emailed you a verification code. Enter it below to finish.");
      } else {
        setError(updateError.message);
      }
      setLoading(false);
      return;
    }
    router.push("/settings?password=changed");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label" htmlFor="current-password">Current password</label>
        <input id="current-password" type="password" required autoComplete="current-password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="new-password">New password</label>
        <input id="new-password" type="password" minLength={MIN_LENGTH} required autoComplete="new-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
        <p className="field-help">At least {MIN_LENGTH} characters. A longer passphrase you don&apos;t use anywhere else is best.</p>
      </div>
      <div>
        <label className="label" htmlFor="confirm-password">Confirm new password</label>
        <input id="confirm-password" type="password" minLength={MIN_LENGTH} required autoComplete="new-password" className="input" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
      </div>
      {needsNonce && (
        <div>
          <label className="label" htmlFor="reauth-code">Verification code from your email</label>
          <input id="reauth-code" inputMode="numeric" autoComplete="one-time-code" required className="input max-w-[12rem] font-mono" value={nonce} onChange={(e) => setNonce(e.target.value)} />
        </div>
      )}
      {error && <p role="alert" className={needsNonce && !nonce ? "alert-warning" : "alert-error"}>{error}</p>}
      <button type="submit" className="btn-primary" disabled={loading}>{loading ? "Updating…" : "Change password"}</button>
    </form>
  );
}
