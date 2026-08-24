import Link from "next/link";
import { Brand } from "@/components/Brand";

export default function AuthErrorPage() {
  return (
    <div className="auth-panel">
      <div className="auth-panel-top"><Brand /><Link href="/">Back to home</Link></div>
      <div className="auth-card">
        <div className="auth-card-header"><span className="eyebrow">Secure link</span><h2>That link didn’t work</h2><p>It may have expired or already been used. Return to sign in and request a fresh link.</p></div>
        <Link className="btn-primary w-full" href="/login">Return to sign in</Link>
      </div>
    </div>
  );
}
