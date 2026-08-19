"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// PRODUCT_BLUEPRINT.md: employer-controlled invitations, not public
// signup — there is deliberately no "create account" link here. Accounts
// are created by an Admin via the invite-employee Edge Function; this page
// only signs an existing account in.
export function LoginForm() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div
      className="relative flex min-h-screen items-center justify-center overflow-hidden px-4"
      style={{
        backgroundImage:
          "radial-gradient(ellipse 1000px 700px at 50% -10%, rgba(140,170,230,0.25), transparent 60%)," +
          "linear-gradient(180deg, #16265F 0%, #0E1A42 55%, #080F28 100%)",
      }}
    >
      {/* Faint gold braid line along the very top, echoing the app header. */}
      <div
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{
          backgroundImage:
            "linear-gradient(90deg, #A2761F, #F5DE95 25%, #C4922A 50%, #F5DE95 75%, #A2761F)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
        }}
      />

      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="crest mx-auto mb-4 h-16 w-16 text-2xl">H</div>
          <h1 className="font-display text-2xl font-bold text-cream-50" style={{ textShadow: "0 2px 6px rgba(0,0,0,0.4)" }}>
            Halomanage
          </h1>
          <p className="mt-1 text-sm text-royal-200/80">Sign in to your organization</p>
        </div>

        <form onSubmit={handleSubmit} className="card space-y-4">
          <div>
            <label className="label" htmlFor="email">Work email</label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p role="alert" className="alert-error">
              {error}
            </p>
          )}

          <button type="submit" disabled={loading} className="btn-primary w-full">
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-royal-200/70">
          New here? Ask your HR administrator to invite you — Halomanage doesn&apos;t use public
          sign-up.
        </p>
      </div>
    </div>
  );
}
