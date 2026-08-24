import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand } from "@/components/Brand";
import { UpdatePasswordForm } from "@/components/UpdatePasswordForm";
import { getCurrentSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function UpdatePasswordPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  return (
    <div className="auth-panel">
      <div className="auth-panel-top"><Brand /><Link href="/">Back to home</Link></div>
      <div className="auth-card">
        <div className="auth-card-header"><span className="eyebrow">Account security</span><h2>Choose a new password</h2><p>Use at least eight characters and avoid passwords you use elsewhere.</p></div>
        <UpdatePasswordForm />
      </div>
    </div>
  );
}
