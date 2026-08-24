"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";

export type WorkspaceSetupDetails = {
  organizationName: string;
  organizationSlug: string;
  firstName: string;
  lastName: string;
  timezone: string;
  countryCode: string;
};

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "organization";
}

function friendlyError(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("could not find the function") || normalized.includes("schema cache")) {
    return "Workspace setup is not available on the connected database yet. Apply the latest Halomanage migrations, then try again.";
  }
  return message;
}

export function CompleteWorkspaceSetup({ initial }: { initial: WorkspaceSetupDetails }) {
  const router = useRouter();
  const started = useRef(false);
  const [organizationName, setOrganizationName] = useState(initial.organizationName);
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName);
  const [countryCode, setCountryCode] = useState(initial.countryCode);
  const [timezone, setTimezone] = useState(initial.timezone || "UTC");
  const [loading, setLoading] = useState(Boolean(initial.organizationName && initial.firstName && initial.lastName));
  const [showForm, setShowForm] = useState(!initial.organizationName || !initial.firstName || !initial.lastName);
  const [error, setError] = useState<string | null>(null);

  async function provision(details: WorkspaceSetupDetails) {
    const supabase = createClient();
    const { error: workspaceError } = await supabase.rpc("create_organization_workspace", {
      p_organization_name: details.organizationName,
      p_slug: details.organizationSlug || slugify(details.organizationName),
      p_first_name: details.firstName,
      p_last_name: details.lastName,
      p_timezone: details.timezone || "UTC",
      p_country_code: details.countryCode || null,
    });

    if (workspaceError?.message.toLowerCase().includes("already belongs")) {
      const { data: repairResult, error: repairError } = await supabase.rpc("repair_current_workspace", {
        p_first_name: details.firstName,
        p_last_name: details.lastName,
      });
      const repairData = repairResult as { repaired?: boolean } | null;
      if (repairError) throw new Error(friendlyError(repairError.message));
      if (!repairData?.repaired) throw new Error("This account already has membership data that could not be repaired automatically. Ask an administrator to review the employee and role records.");
    } else if (workspaceError) {
      const readable = friendlyError(workspaceError.message);
      throw new Error(readable);
    }

    router.push("/dashboard");
    router.refresh();
  }

  useEffect(() => {
    if (started.current || showForm) return;
    started.current = true;

    void provision(initial).catch((setupError: unknown) => {
      setError(setupError instanceof Error ? setupError.message : "We could not finish creating your workspace.");
      setLoading(false);
      setShowForm(true);
    });
    // `initial` is server-provided immutable signup data; this effect runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await provision({
        organizationName,
        organizationSlug: initial.organizationSlug || slugify(organizationName),
        firstName,
        lastName,
        timezone,
        countryCode,
      });
    } catch (setupError) {
      setError(setupError instanceof Error ? setupError.message : "We could not finish creating your workspace.");
      setLoading(false);
    }
  }

  return (
    <div className="workspace-completion-shell">
      <div className="workspace-completion-story">
        <span className="eyebrow">Your workspace foundation</span>
        <h1>Let&apos;s connect the account you already created.</h1>
        <p>This creates your organization, Admin access, employee profile, working schedule, leave policies, and starter workflows in one secure transaction.</p>
        <div className="completion-benefits">
          <span><Icon name="check" size={16} /> Administrator access</span>
          <span><Icon name="check" size={16} /> Employee portal address</span>
          <span><Icon name="check" size={16} /> Useful starter policies</span>
        </div>
      </div>

      <div className="auth-card workspace-completion-card">
        {showForm ? (
          <form className="auth-form" onSubmit={handleSubmit}>
            <div className="auth-card-header"><span className="eyebrow">Repair workspace</span><h2>Confirm your organization</h2><p>Your login is active. These details will connect it to the business workspace.</p></div>
            <div><label className="label" htmlFor="repair-org">Organization name</label><input id="repair-org" className="input" required maxLength={120} value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} placeholder="iCreate Solutions and Services" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label" htmlFor="repair-first">First name</label><input id="repair-first" className="input" required maxLength={80} value={firstName} onChange={(event) => setFirstName(event.target.value)} /></div>
              <div><label className="label" htmlFor="repair-last">Last name</label><input id="repair-last" className="input" required maxLength={80} value={lastName} onChange={(event) => setLastName(event.target.value)} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label" htmlFor="repair-country">Country</label><input id="repair-country" className="input" maxLength={2} value={countryCode} onChange={(event) => setCountryCode(event.target.value.replace(/[^a-z]/gi, "").toUpperCase())} placeholder="JM" /></div>
              <div><label className="label" htmlFor="repair-timezone">Timezone</label><input id="repair-timezone" className="input" required maxLength={100} value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="America/Jamaica" /></div>
            </div>
            {error && <p className="alert-error" role="alert">{error}</p>}
            <button className="btn-primary w-full" disabled={loading} type="submit">{loading ? "Connecting workspace…" : <>Connect my workspace <Icon name="arrow-right" size={16} /></>}</button>
          </form>
        ) : (
          <div className="auth-form signup-confirmation">
            <span className="setup-spinner" aria-hidden="true" />
            <div><h3>Preparing {organizationName}</h3><p>We&apos;re creating your Admin access, people records, starter policies, and employee portal.</p></div>
          </div>
        )}
      </div>
    </div>
  );
}
