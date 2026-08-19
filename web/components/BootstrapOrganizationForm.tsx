"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

function slugify(name: string) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "org";
}

// Ref: supabase/migrations/20260818001900_bootstrap_first_organization.sql
// — only ever works once, when the whole deployment has zero organizations.
// This component only ever renders in that exact state (the dashboard page
// checks deployment_needs_bootstrap() before showing it), so there's no
// separate "are you sure this isn't a duplicate signup" concern here — the
// database itself is the single source of truth for whether this is
// allowed, re-checked server-side inside the same transaction regardless
// of what this form thinks it knows.
export function BootstrapOrganizationForm() {
  const supabase = createClient();
  const router = useRouter();
  const [organizationName, setOrganizationName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.rpc("bootstrap_first_organization", {
      p_organization_name: organizationName,
      p_slug: slugify(organizationName),
      p_first_name: firstName,
      p_last_name: lastName,
      p_timezone: timezone || "UTC",
      p_country_code: countryCode || null,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.refresh();
  }

  return (
    <div className="card max-w-lg space-y-4">
      <div>
        <h2 className="font-display text-lg font-bold text-stone-900">Welcome to Halomanage</h2>
        <p className="mt-1 text-sm text-stone-600">
          No organization has been set up on this deployment yet, and you&apos;re signed in — so
          you&apos;re the first person here. Set up your company and you&apos;ll become its Admin.
          This only ever works once; everyone who joins afterward gets a real invitation instead.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="label">Company / organization name</label>
          <input required className="input" value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Your first name</label>
            <input required className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </div>
          <div>
            <label className="label">Your last name</label>
            <input required className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </div>
          <div>
            <label className="label">Country code (optional)</label>
            <input placeholder="JM" className="input" value={countryCode} onChange={(e) => setCountryCode(e.target.value.toUpperCase())} />
          </div>
          <div>
            <label className="label">Timezone</label>
            <input placeholder="America/Jamaica" className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          </div>
        </div>

        {error && <p className="alert-error">{error}</p>}

        <button type="submit" disabled={loading} className="btn-primary w-full">
          {loading ? "Setting up…" : "Set up my organization"}
        </button>
      </form>
    </div>
  );
}
