"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export type MfaFactor = { id: string; friendly_name: string | null; created_at: string };

// Authenticator-app (TOTP) multi-factor authentication with Supabase Auth:
// enroll → scan QR → verify a 6-digit code. A successful verification
// upgrades this session to aal2, which the database checks before
// sensitive actions when the organization requires it.
export function MfaEnrollment({ onDone, label = "Set up authenticator app" }: { onDone?: () => void; label?: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [stage, setStage] = useState<"idle" | "scan">("idle");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setLoading(true);
    setError(null);
    // An abandoned earlier attempt leaves an unverified factor behind;
    // clear it so enrollment can start cleanly.
    const { data: factors } = await supabase.auth.mfa.listFactors();
    for (const f of factors?.all ?? []) {
      if (f.factor_type === "totp" && f.status !== "verified") await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data, error: enrollError } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `Authenticator ${new Date().toLocaleDateString("en-CA")}` });
    if (enrollError || !data) {
      setError(enrollError?.message ?? "Could not start setup.");
      setLoading(false);
      return;
    }
    setFactorId(data.id);
    setQr(data.totp.qr_code);
    setSecret(data.totp.secret);
    setStage("scan");
    setLoading(false);
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (!factorId) return;
    setLoading(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    if (verifyError) {
      setError(verifyError.message === "Invalid TOTP code entered" ? "That code didn't match — check the time on your phone and try the newest code." : verifyError.message);
      setLoading(false);
      return;
    }
    setLoading(false);
    setStage("idle");
    onDone?.();
    router.refresh();
  }

  if (stage === "idle") {
    return (
      <div className="flex flex-col items-start gap-1">
        <button type="button" className="btn-primary" disabled={loading} onClick={start}>{loading ? "Starting…" : label}</button>
        {error && <p role="alert" className="text-xs text-ruby-600">{error}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={verify} className="space-y-3 rounded-xl border border-stone-200 p-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-stone-700">
        <li>Open an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…).</li>
        <li>Scan this code, or type the setup key.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      {/* eslint-disable-next-line @next/next/no-img-element -- Supabase returns the QR as an SVG data URI */}
      {qr && <img src={qr} alt="QR code for your authenticator app" width={180} height={180} className="rounded-lg border border-stone-100 bg-white p-2" />}
      {secret && <p className="text-xs text-stone-500">Setup key: <code className="select-all break-all font-mono text-stone-800">{secret}</code></p>}
      <div>
        <label className="label" htmlFor="mfa-code">6-digit code</label>
        <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required className="input max-w-[10rem] font-mono tracking-widest" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
      </div>
      {error && <p role="alert" className="alert-error">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={loading || code.length !== 6}>{loading ? "Verifying…" : "Verify and turn on"}</button>
        <button type="button" className="btn-secondary" onClick={() => setStage("idle")}>Cancel</button>
      </div>
    </form>
  );
}

// Verify with an existing authenticator (step-up to aal2).
export function MfaChallenge({ factorId, next }: { factorId: string; next: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    if (verifyError) {
      setError(verifyError.message === "Invalid TOTP code entered" ? "That code didn't match — try the newest code in your app." : verifyError.message);
      setLoading(false);
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <form onSubmit={verify} className="space-y-3">
      <div>
        <label className="label" htmlFor="mfa-challenge-code">Code from your authenticator app</label>
        <input id="mfa-challenge-code" autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required className="input font-mono tracking-widest" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
      </div>
      {error && <p role="alert" className="alert-error">{error}</p>}
      <button type="submit" className="btn-primary w-full" disabled={loading || code.length !== 6}>{loading ? "Verifying…" : "Verify"}</button>
    </form>
  );
}

export function MfaFactorList({ factors, currentAal, requiredByOrg }: { factors: MfaFactor[]; currentAal: string; requiredByOrg: boolean }) {
  const supabase = createClient();
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(factor: MfaFactor) {
    if (!window.confirm("Remove this authenticator? You'll no longer be asked for its codes.")) return;
    setBusyId(factor.id);
    setError(null);
    const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    if (unenrollError) setError(unenrollError.message);
    setBusyId(null);
    router.refresh();
  }

  const lastRequired = requiredByOrg && factors.length <= 1;
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-stone-100 text-sm">
        {factors.map((factor) => (
          <li key={factor.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>{factor.friendly_name || "Authenticator app"} <span className="text-xs text-stone-400">· added {factor.created_at.slice(0, 10)}</span></span>
            {lastRequired ? (
              <span className="text-xs text-stone-500">Required by your organization</span>
            ) : currentAal !== "aal2" ? (
              <Link className="text-xs text-royal-700 hover:underline" href="/mfa?next=/settings">Verify to manage</Link>
            ) : (
              <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={busyId === factor.id} onClick={() => remove(factor)}>Remove</button>
            )}
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="alert-error">{error}</p>}
    </div>
  );
}

// Sessions & devices. "Sign out" elsewhere in the app is this device only.
export function SessionControls() {
  const supabase = createClient();
  const router = useRouter();
  const [busy, setBusy] = useState<"others" | "global" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signOut(scope: "others" | "global") {
    const prompt = scope === "others"
      ? "Sign out every other browser and device? You'll stay signed in here."
      : "Sign out of HaloManage everywhere, including this device?";
    if (!window.confirm(prompt)) return;
    setBusy(scope);
    setError(null);
    setMessage(null);
    const { error: signOutError } = await supabase.auth.signOut({ scope });
    setBusy(null);
    if (signOutError) {
      setError(signOutError.message);
      return;
    }
    if (scope === "global") {
      router.push("/login");
      router.refresh();
    } else {
      setMessage("Other devices are signed out. They may keep access for up to an hour until their current session token expires.");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => signOut("others")}>{busy === "others" ? "Signing out…" : "Sign out other devices"}</button>
        <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => signOut("global")}>{busy === "global" ? "Signing out…" : "Sign out everywhere"}</button>
      </div>
      {message && <p role="status" className="text-xs text-emerald-700">{message}</p>}
      {error && <p role="alert" className="alert-error">{error}</p>}
    </div>
  );
}
