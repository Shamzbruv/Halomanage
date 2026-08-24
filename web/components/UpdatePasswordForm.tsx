"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function UpdatePasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="auth-form">
      <div><label className="label" htmlFor="new-password">New password</label><input id="new-password" type="password" minLength={8} required autoComplete="new-password" className="input" value={password} onChange={(event) => setPassword(event.target.value)} /></div>
      <div><label className="label" htmlFor="confirm-password">Confirm new password</label><input id="confirm-password" type="password" minLength={8} required autoComplete="new-password" className="input" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div>
      {error && <p role="alert" className="alert-error">{error}</p>}
      <button className="btn-primary w-full" disabled={loading} type="submit">{loading ? "Updating…" : "Update password"}</button>
    </form>
  );
}
