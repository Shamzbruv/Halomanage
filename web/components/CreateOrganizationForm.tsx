"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";

function slugify(name: string) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "organization";
}

export function CreateOrganizationForm() {
  const supabase = createClient();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState(false);

  async function createWorkspace() {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    return supabase.rpc("create_organization_workspace", {
      p_organization_name: organizationName,
      p_slug: slugify(organizationName),
      p_first_name: firstName,
      p_last_name: lastName,
      p_timezone: timezone,
      p_country_code: countryCode || null,
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/signup/complete`,
        data: {
          signup_intent: "organization_owner",
          organization_name: organizationName,
          organization_slug: slugify(organizationName),
          first_name: firstName,
          last_name: lastName,
          country_code: countryCode || null,
          timezone,
        },
      },
    });

    if (signUpError) {
      setError(signUpError.message);
      setLoading(false);
      return;
    }

    if (!signUpData.session) {
      setPendingConfirmation(true);
      setLoading(false);
      return;
    }

    const { error: workspaceError } = await createWorkspace();
    if (workspaceError) {
      setError(workspaceError.message);
      setLoading(false);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  if (pendingConfirmation) {
    return (
      <div className="auth-form signup-confirmation">
        <span className="signup-confirmation-icon"><Icon name="check" size={22} /></span>
        <div><h3>Check your inbox</h3><p>We sent a secure confirmation link to <strong>{email}</strong>. Open it to finish creating {organizationName}.</p></div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="auth-form">
      <div>
        <label className="label" htmlFor="new-org-name">Organization name</label>
        <input id="new-org-name" required maxLength={120} className="input" placeholder="Acme & Co." value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label" htmlFor="new-first-name">First name</label><input id="new-first-name" required maxLength={80} autoComplete="given-name" className="input" placeholder="Maya" value={firstName} onChange={(e) => setFirstName(e.target.value)} /></div>
        <div><label className="label" htmlFor="new-last-name">Last name</label><input id="new-last-name" required maxLength={80} autoComplete="family-name" className="input" placeholder="Williams" value={lastName} onChange={(e) => setLastName(e.target.value)} /></div>
      </div>
      <div>
        <label className="label" htmlFor="new-email">Work email</label>
        <input id="new-email" type="email" required autoComplete="email" className="input" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="new-password">Password <span className="label-hint">8+ characters</span></label>
        <input id="new-password" type="password" required minLength={8} autoComplete="new-password" className="input" placeholder="Create a strong password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="new-country">Country code <span className="label-hint">Optional</span></label>
        <input id="new-country" maxLength={2} className="input" placeholder="JM" value={countryCode} onChange={(e) => setCountryCode(e.target.value.replace(/[^a-z]/gi, "").toUpperCase())} />
      </div>
      <label className="checkbox-row"><input type="checkbox" required checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /><span>I&apos;m authorized to create this organization&apos;s workspace and agree to handle employee information responsibly.</span></label>
      {error && <p role="alert" className="alert-error">{error}</p>}
      <button type="submit" disabled={loading || !accepted} className="btn-primary w-full">
        {loading ? "Creating your workspace…" : <>Create workspace <Icon name="arrow-right" size={16} /></>}
      </button>
    </form>
  );
}
