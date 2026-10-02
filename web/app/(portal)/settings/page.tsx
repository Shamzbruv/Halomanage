import Link from "next/link";
import { redirect } from "next/navigation";
import { NotificationPreferencesForm } from "@/components/NotificationPreferencesForm";
import { getCurrentSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

// Account preferences — separate from My Profile, which is the employee
// record itself. Language is deliberately not offered yet: HaloManage has
// no translations, and a preference that changes nothing would mislead.
export default async function SettingsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee || !session.organizationId) redirect("/signup/complete?repair=1");

  const supabase = await createClient();
  const { data: disabledPreferences } = await supabase
    .from("notification_preferences")
    .select("notification_type")
    .eq("user_id", session.userId)
    .eq("organization_id", session.organizationId)
    .eq("channel", "in_app")
    .eq("enabled", false);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="page-intro"><span className="eyebrow">Settings</span><h1>Your account preferences.</h1><p>How HaloManage works for you. Your employee record itself is under <Link className="text-royal-700 hover:underline" href="/profile">My profile</Link>.</p></div>

      <section className="card">
        <h2 className="mb-1 text-sm font-semibold text-stone-900">In-app notifications</h2>
        <p className="mb-4 text-xs text-stone-500">
          Choose what appears in your notification bell. Some notifications are required by your organization and can&apos;t be turned off. Email and text message delivery aren&apos;t switched on yet.
        </p>
        <NotificationPreferencesForm
          userId={session.userId}
          organizationId={session.organizationId}
          disabledTypes={(disabledPreferences ?? []).map((p) => p.notification_type)}
        />
      </section>

      <section className="card">
        <h2 className="mb-1 text-sm font-semibold text-stone-900">Password &amp; sign-in</h2>
        <p className="mb-3 text-xs text-stone-500">Change the password you use to sign in to HaloManage.</p>
        <Link className="btn-secondary" href="/update-password">Change password</Link>
      </section>
    </div>
  );
}
