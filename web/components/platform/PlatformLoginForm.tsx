"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// A deliberately separate sign-in from /login: platform staff use the same
// Supabase account they might also use as a tenant employee somewhere, but
// this form's only job is to check platform_staff membership afterward —
// see lib/platform-session.ts. Anyone without a platform_staff row is
// signed back out immediately rather than left in a half-authenticated
// state that only fails once they click into a page.
export function PlatformLoginForm() {
  const supabase = createClient();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError || !data.user) {
      setError(signInError?.message ?? "Could not sign in.");
      setLoading(false);
      return;
    }

    const { data: staffRow } = await supabase.from("platform_staff").select("id").eq("user_id", data.user.id).maybeSingle();
    if (!staffRow) {
      await supabase.auth.signOut();
      setError("This account has no platform access.");
      setLoading(false);
      return;
    }

    router.push("/platform");
    router.refresh();
  }

  return (
    <div className="platform-login-shell">
      <div className="platform-login-card">
        <p style={{ fontSize: ".7rem", fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "#8592ad" }}>Halomanage HQ</p>
        <h1 style={{ marginTop: ".3rem", marginBottom: "1.25rem", fontFamily: "var(--font-display), Georgia, serif", fontSize: "1.5rem", fontWeight: 500 }}>
          Platform console
        </h1>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
          <div>
            <label className="platform-label" htmlFor="platform-email">Email</label>
            <input
              id="platform-email"
              type="email"
              required
              autoComplete="username"
              className="platform-input"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div>
            <label className="platform-label" htmlFor="platform-password">Password</label>
            <input
              id="platform-password"
              type="password"
              required
              autoComplete="current-password"
              className="platform-input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {error && <p className="platform-alert-error" role="alert">{error}</p>}
          <button type="submit" disabled={loading} className="platform-btn platform-btn-primary" style={{ justifyContent: "center" }}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
