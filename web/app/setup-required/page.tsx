import Link from "next/link";
import { Brand } from "@/components/Brand";
import { Icon } from "@/components/Icon";

export default async function SetupRequiredPage({ searchParams }: { searchParams: Promise<{ reason?: string; detail?: string }> }) {
  const { reason, detail } = await searchParams;
  const urlSet = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const keySet = Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const connectionError = reason === "error";

  return (
    <div className="setup-page">
      <header><Brand /><Link href="/">View public site</Link></header>
      <main>
        <span className="setup-hero-icon"><Icon name="settings" size={30} /></span>
        <span className="eyebrow">Deployment setup</span>
        <h1>{connectionError ? "We couldn’t reach your data workspace." : "Connect Halomanage to Supabase."}</h1>
        <p>{connectionError ? "The app can see its configuration, but the connection failed. Confirm the project is active and the values match your Supabase project." : "The public site is ready. Add the two Supabase environment variables below to turn on accounts and the employee workspace."}</p>

        {connectionError && detail && <div className="setup-error"><strong>Connection response</strong><code>{detail}</code></div>}

        <section className="setup-checklist">
          <div><span className={urlSet ? "ready" : "missing"}>{urlSet ? <Icon name="check" size={15} /> : "1"}</span><div><strong>NEXT_PUBLIC_SUPABASE_URL</strong><small>{urlSet ? "Configured" : "Add your project URL"}</small></div></div>
          <div><span className={keySet ? "ready" : "missing"}>{keySet ? <Icon name="check" size={15} /> : "2"}</span><div><strong>NEXT_PUBLIC_SUPABASE_ANON_KEY</strong><small>{keySet ? "Configured" : "Add your public or publishable key"}</small></div></div>
          <div><span className="missing">3</span><div><strong>Apply database migrations</strong><small>Run the migrations in supabase/migrations, then reload this deployment.</small></div></div>
        </section>
        <p className="setup-note">Use the public/publishable browser key here—never a service-role or secret key. For hosted environments, redeploy after changing variables.</p>
      </main>
    </div>
  );
}
