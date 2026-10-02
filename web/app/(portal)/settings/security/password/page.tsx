import Link from "next/link";
import { redirect } from "next/navigation";
import { ChangePasswordForm } from "@/components/settings/ChangePasswordForm";
import { getCurrentSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

// Password change from inside the app (Settings → Account security).
// Organizations that enforce single sign-on manage credentials in their
// identity provider, so there is nothing to change here for them.
export default async function ChangePasswordPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const [{ data: policy }, { data: userData }] = await Promise.all([
    supabase.rpc("get_my_security_policy"),
    supabase.auth.getUser(),
  ]);
  const hasPassword = (userData.user?.identities ?? []).some((identity) => identity.provider === "email");
  if ((policy as { sso_enforced?: boolean } | null)?.sso_enforced || !hasPassword) redirect("/settings");

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <Link href="/settings" className="text-xs text-royal-700 hover:text-royal-800">← Settings</Link>
        <div className="page-intro mt-2"><span className="eyebrow">Account security</span><h1>Change your password.</h1><p>You&apos;ll stay signed in on this device. You can sign out your other devices afterwards from Settings.</p></div>
      </div>
      <section className="card">
        <ChangePasswordForm />
      </section>
    </div>
  );
}
