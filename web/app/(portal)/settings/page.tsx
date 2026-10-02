import Link from "next/link";
import { redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { NotificationPreferencesForm } from "@/components/NotificationPreferencesForm";
import { RequestCorrectionButton } from "@/components/profile/RecordRequestControls";
import { MfaEnrollment, MfaFactorList, SessionControls } from "@/components/settings/MfaManager";
import { ALL_NOTIFICATION_TYPES, NOTIFICATION_GROUPS, SECURITY_ACTIVITY_LABELS, groupRequirement, type RequiredState } from "@/lib/notifications";
import { getCurrentSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/timezone";

type SecurityPolicy = {
  mfa_policy: "optional" | "admins" | "managers_and_admins" | "everyone";
  mfa_required: boolean;
  step_up_for_sensitive_actions: boolean;
  current_aal: string;
  sso_available: boolean;
  sso_enforced: boolean;
  sso_domain: string | null;
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-stone-100 py-3 sm:grid-cols-[200px_1fr]">
      <dt className="text-xs font-semibold uppercase text-stone-400">{label}</dt>
      <dd className="text-sm text-stone-800">{children}</dd>
    </div>
  );
}

// Settings is how the person uses HaloManage — notifications, account
// security, sessions. The employee record itself is My Profile. Nothing is
// shown here that doesn't work yet (no language, theme or timezone
// switches: there are no translations, and operational dates follow the
// organization's timezone by design).
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ password?: string }> }) {
  const { password: passwordFlag } = await searchParams;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee || !session.organizationId) redirect("/signup/complete?repair=1");
  const timezone = session.organization?.timezone;

  const supabase = await createClient();
  const [{ data: userData }, { data: policyData }, { data: factorData }, { data: activity }, { data: requiredRows }, { data: disabledPreferences }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.rpc("get_my_security_policy"),
    supabase.auth.mfa.listFactors(),
    supabase.rpc("list_my_security_activity"),
    supabase.rpc("get_required_notifications", { p_types: ALL_NOTIFICATION_TYPES, p_channel: "in_app" }),
    supabase.from("notification_preferences").select("notification_type").eq("user_id", session.userId).eq("organization_id", session.organizationId).eq("channel", "in_app").eq("enabled", false),
  ]);
  const user = userData.user;
  const policy = (policyData as SecurityPolicy | null) ?? null;
  const factors = (factorData?.totp ?? []).filter((f) => f.status === "verified").map((f) => ({ id: f.id, friendly_name: f.friendly_name ?? null, created_at: f.created_at }));
  const requirements: Record<string, RequiredState> = Object.fromEntries(
    NOTIFICATION_GROUPS.map((g) => [g.key, groupRequirement(g, (requiredRows ?? []) as { notification_type: string; required: boolean; system_required: boolean }[])]),
  );

  const providers = new Set((user?.identities ?? []).map((identity) => identity.provider));
  const hasPassword = providers.has("email");
  const hasSso = [...providers].some((p) => p.startsWith("sso"));
  const ssoEnforced = !!policy?.sso_enforced;
  const method = ssoEnforced || (hasSso && !hasPassword)
    ? "Company single sign-on"
    : hasSso || policy?.sso_available ? "Email & password, or company single sign-on" : "Email & password";
  const canChangePassword = hasPassword && !ssoEnforced;
  const mfaRequired = !!policy?.mfa_required;
  const aal = policy?.current_aal ?? "aal1";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="page-intro"><span className="eyebrow">Settings</span><h1>Your account and preferences.</h1><p>How HaloManage works for you. Your employee record itself is under <Link className="text-royal-700 hover:underline" href="/profile">My profile</Link>.</p></div>

      {passwordFlag === "changed" && (
        <p className="portal-card-status" role="status"><Icon name="check" size={15} /> Password changed. If you&apos;re signed in on other devices, you can sign them out below.</p>
      )}

      <section className="card">
        <h2 className="mb-1 text-sm font-semibold text-stone-900">Notifications</h2>
        <p className="mb-4 text-xs text-stone-500">
          Choose which optional updates appear in your notification bell. Required work and record notices stay on. Email and text-message delivery aren&apos;t switched on yet.
        </p>
        <NotificationPreferencesForm userId={session.userId} organizationId={session.organizationId} disabledTypes={(disabledPreferences ?? []).map((p) => p.notification_type)} requirements={requirements} />
      </section>

      <section className="card">
        <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-stone-900"><Icon name="shield" size={16} /> Account security</h2>
        <p className="mb-2 text-xs text-stone-500">Some security settings are managed by your organization&apos;s administrator.</p>
        <dl>
          <Row label="Sign-in email">
            <span className="font-medium">{user?.email ?? session.email ?? "—"}</span>
            <span className="ml-2 text-xs text-stone-500">Managed by your organization</span>
            <div className="mt-1"><RequestCorrectionButton compact defaultField="work_email" label="Wrong email? Request a correction" /></div>
          </Row>
          <Row label="Sign-in method">
            {method}
            {ssoEnforced && <p className="mt-1 text-xs text-stone-500">Your password is managed by your organization&apos;s identity provider{policy?.sso_domain ? ` (${policy.sso_domain})` : ""}. Change it there, not in HaloManage.</p>}
          </Row>
          {canChangePassword && (
            <Row label="Password">
              <Link className="btn-secondary px-3 py-1.5 text-xs" href="/settings/security/password">Change password</Link>
            </Row>
          )}
          <Row label="Multi-factor authentication">
            <p className="mb-2">
              {factors.length > 0 ? <span className="badge badge-emerald">On</span> : <span className="badge badge-neutral">Not set up</span>}
              {mfaRequired && <span className="ml-2 text-xs text-stone-600">Required by your organization</span>}
              {!mfaRequired && policy?.step_up_for_sensitive_actions && <span className="ml-2 text-xs text-stone-600">Needed for sensitive actions in your organization</span>}
            </p>
            {factors.length > 0 && <MfaFactorList factors={factors} currentAal={aal} requiredByOrg={mfaRequired} />}
            {factors.length > 0 && aal !== "aal2" && (
              <p className="mt-2 text-xs text-stone-600">This session hasn&apos;t been verified with your authenticator yet. <Link className="text-royal-700 hover:underline" href="/mfa?next=/settings">Verify now</Link></p>
            )}
            {factors.length === 0 && (
              <>
                <p className="mb-3 text-xs text-stone-500">Add a second step at sign-in: a 6-digit code from an authenticator app on your phone.</p>
                <MfaEnrollment />
              </>
            )}
          </Row>
          <Row label="Last sign-in">{user?.last_sign_in_at ? formatDateTime(user.last_sign_in_at, timezone, { dateStyle: "long", timeStyle: "short" }) : "—"}</Row>
        </dl>

        <h3 className="mb-2 mt-5 text-xs font-semibold uppercase text-stone-400">Recent security activity</h3>
        {(activity ?? []).length === 0 ? (
          <p className="text-sm text-stone-400">No recent activity recorded.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {((activity ?? []) as { occurred_at: string; action: string }[]).map((event, i) => (
              <li key={`${event.occurred_at}-${i}`} className="flex justify-between gap-3">
                <span>{SECURITY_ACTIVITY_LABELS[event.action] ?? event.action}</span>
                <span className="text-xs text-stone-500">{formatDateTime(event.occurred_at, timezone, { dateStyle: "medium", timeStyle: "short" })}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 className="mb-1 text-sm font-semibold text-stone-900">Sessions &amp; devices</h2>
        <p className="mb-4 text-xs text-stone-500">&ldquo;Sign out&rdquo; in the menu signs out this device only. Use these if you&apos;ve signed in somewhere you no longer trust.</p>
        <SessionControls />
      </section>
    </div>
  );
}
