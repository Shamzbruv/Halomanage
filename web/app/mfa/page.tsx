import { redirect } from "next/navigation";
import { Brand } from "@/components/Brand";
import { SignOutButton } from "@/components/SignOutButton";
import { MfaChallenge, MfaEnrollment } from "@/components/settings/MfaManager";
import { getCurrentSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Outside the portal on purpose: the portal layout sends anyone whose
// organization requires MFA here until their session is verified (aal2),
// so this page must not itself be inside that gate. Also the step-up page
// for sensitive actions (?next=…).
export default async function MfaPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next: requestedNext } = await searchParams;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const next = requestedNext && requestedNext.startsWith("/") && !requestedNext.startsWith("//") ? requestedNext : "/dashboard";

  const supabase = await createClient();
  const [{ data: factorData }, { data: policy }] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase.rpc("get_my_security_policy"),
  ]);
  const verified = (factorData?.totp ?? []).find((f) => f.status === "verified");
  const p = policy as { mfa_required?: boolean; current_aal?: string } | null;
  if (verified && p?.current_aal === "aal2") redirect(next);

  return (
    <div className="auth-panel">
      <div className="auth-panel-top"><Brand /><SignOutButton /></div>
      <div className="auth-card">
        {verified ? (
          <>
            <div className="auth-card-header"><span className="eyebrow">Verify it&apos;s you</span><h2>Enter your authenticator code</h2><p>Open your authenticator app and enter the 6-digit code for HaloManage.</p></div>
            <MfaChallenge factorId={verified.id} next={next} />
          </>
        ) : (
          <>
            <div className="auth-card-header">
              <span className="eyebrow">Account security</span>
              <h2>Set up multi-factor authentication</h2>
              <p>{p?.mfa_required
                ? "Your organization requires a second sign-in step for your account. It takes about a minute with an authenticator app on your phone."
                : "This action needs a verified second sign-in step. Set up an authenticator app to continue."}</p>
            </div>
            <MfaEnrollment label="Start setup" />
          </>
        )}
      </div>
    </div>
  );
}
