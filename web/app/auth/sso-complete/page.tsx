import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand } from "@/components/Brand";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function SsoCompletePage() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) redirect("/login");

  const { error } = await supabase.rpc("link_sso_employee_account");
  if (!error) redirect("/dashboard");

  console.error("sso completion: account could not be linked", { code: error.code });
  return (
    <main className="workspace-repair-shell">
      <Brand />
      <section className="card workspace-repair-card">
        <span className="eyebrow">Company sign-in</span>
        <h1>Your identity is verified, but no eligible employee record matched it.</h1>
        <p>Ask your HR administrator to confirm that your work email is on your employee profile and that the SSO connection is active.</p>
        <Link className="btn-primary" href="/login">Return to sign in</Link>
      </section>
    </main>
  );
}
