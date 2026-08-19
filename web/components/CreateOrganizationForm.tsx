"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "org"
  );
}

// The other half of the bootstrap story alongside BootstrapOrganizationForm:
// that one assumes an auth.users account already exists and just needs an
// organization. This one is for when *neither* exists yet — the actual
// "how do I sign up as the very first admin" flow, which previously had no
// answer inside the product at all (the only way in was creating a user
// directly in the Supabase dashboard). Only ever rendered by /login when
// deployment_needs_bootstrap() is true; see
// supabase/migrations/20260818001900_bootstrap_first_organization.sql for
// why this can't be abused as a general public-signup mechanism — the
// database itself refuses a second one, permanently, the moment one
// organization exists anywhere.
export function CreateOrganizationForm() {
  const supabase = createClient();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({ email, password });

    if (signUpError) {
      setError(signUpError.message);
      setLoading(false);
      return;
    }

    if (!signUpData.session) {
      // Email confirmation is required before a session exists. Nothing
      // more to do here — the dashboard's own deployment_needs_bootstrap()
      // check will show BootstrapOrganizationForm the moment they confirm
      // and sign in, so the organization still gets created, just one step
      // later.
      setPendingConfirmation(true);
      setLoading(false);
      return;
    }

    const { error: bootstrapError } = await supabase.rpc("bootstrap_first_organization", {
      p_organization_name: organizationName,
      p_slug: slugify(organizationName),
      p_first_name: firstName,
      p_last_name: lastName,
      p_timezone: "UTC",
      p_country_code: null,
    });

    if (bootstrapError) {
      setError(bootstrapError.message);
      setLoading(false);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  if (pendingConfirmation) {
    return (
      <div className="card space-y-3 text-sm text-stone-700">
        <h2 className="font-display text-lg font-bold text-stone-900">Check your email</h2>
        <p>
          We sent a confirmation link to <strong>{email}</strong>. Click it, then come back and
          sign in — your organization will be set up automatically the moment you do.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-4">
      <div>
        <label className="label" htmlFor="new-org-name">Company / organization name</label>
        <input id="new-org-name" required className="input" value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="new-first-name">Your first name</label>
          <input id="new-first-name" required className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="new-last-name">Your last name</label>
          <input id="new-last-name" required className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="new-email">Work email</label>
        <input id="new-email" type="email" required autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="new-password">Password</label>
        <input
          id="new-password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      {error && <p className="alert-error">{error}</p>}

      <button type="submit" disabled={loading} className="btn-primary w-full">
        {loading ? "Setting up…" : "Create my organization"}
      </button>
    </form>
  );
}
