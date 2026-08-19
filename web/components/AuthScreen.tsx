"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { LoginForm } from "@/components/LoginForm";
import { CreateOrganizationForm } from "@/components/CreateOrganizationForm";

// deployment_needs_bootstrap() is granted to the `anon` role specifically so
// this check can run before anyone is signed in — see
// supabase/migrations/20260818001900_bootstrap_first_organization.sql. Until
// we know the answer we show neither form, to avoid a flash of the wrong
// one (briefly offering "create organization" on a deployment that already
// has one, or vice versa).
export function AuthScreen() {
  const [needsBootstrap, setNeedsBootstrap] = useState<boolean | null>(null);
  // Covers the account-created-another-way case (e.g. directly in the
  // Supabase dashboard, which is how this project's very first account
  // was actually created, before this form existed) — deployment_needs_bootstrap()
  // being true doesn't mean *nobody* has an auth.users account yet, only
  // that nobody has finished setting up an organization. Without this
  // toggle, a person in that exact situation would have no way to sign in
  // at all while bootstrap is pending — CreateOrganizationForm's signUp()
  // would collide with their existing account instead.
  const [showSignInInstead, setShowSignInInstead] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase
      .rpc("deployment_needs_bootstrap")
      .then(({ data, error }) => {
        if (cancelled) return;
        // If the check itself fails (e.g. a genuinely broken backend), fall
        // back to the ordinary sign-in form rather than silently offering
        // to create a second organization — that failure mode gets caught
        // by the middleware's own setup-required diagnostics anyway.
        setNeedsBootstrap(error ? false : Boolean(data));
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
          <Link href="/" className="inline-block">
            <div className="crest mx-auto mb-4 h-16 w-16 text-2xl">H</div>
          </Link>
          <h1 className="font-display text-2xl font-bold text-cream-50" style={{ textShadow: "0 2px 6px rgba(0,0,0,0.4)" }}>
            Halomanage
          </h1>
          <p className="mt-1 text-sm text-royal-200/80">
            {needsBootstrap && !showSignInInstead ? "Set up your organization" : "Sign in to your organization"}
          </p>
        </div>

        {needsBootstrap === null && (
          <div className="card text-center text-sm text-stone-500">Loading…</div>
        )}
        {needsBootstrap === true && !showSignInInstead && (
          <>
            <CreateOrganizationForm />
            <p className="mt-5 text-center text-xs text-royal-200/70">
              Already have an account?{" "}
              <button
                type="button"
                onClick={() => setShowSignInInstead(true)}
                className="font-semibold text-gold-200 underline decoration-gold-400/50 underline-offset-2 hover:text-gold-100"
              >
                Sign in instead
              </button>
            </p>
          </>
        )}
        {needsBootstrap === true && showSignInInstead && (
          <>
            <LoginForm showInviteOnlyNotice={false} />
            <p className="mt-5 text-center text-xs text-royal-200/70">
              <button
                type="button"
                onClick={() => setShowSignInInstead(false)}
                className="font-semibold text-gold-200 underline decoration-gold-400/50 underline-offset-2 hover:text-gold-100"
              >
                ← Back to setting up your organization
              </button>
            </p>
          </>
        )}
        {needsBootstrap === false && <LoginForm />}
      </div>
    </div>
  );
}
