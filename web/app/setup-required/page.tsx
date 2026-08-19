// Served (via a middleware rewrite — see lib/supabase/middleware.ts) for
// every route when NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY
// aren't set. Deliberately has zero dependency on Supabase or any env var,
// so it can always render regardless of what's misconfigured.
export default function SetupRequiredPage() {
  return (
    <div
      className="relative flex min-h-screen items-center justify-center overflow-hidden px-4"
      style={{
        backgroundImage:
          "radial-gradient(ellipse 1000px 700px at 50% -10%, rgba(140,170,230,0.25), transparent 60%)," +
          "linear-gradient(180deg, #16265F 0%, #0E1A42 55%, #080F28 100%)",
      }}
    >
      <div
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{
          backgroundImage:
            "linear-gradient(90deg, #A2761F, #F5DE95 25%, #C4922A 50%, #F5DE95 75%, #A2761F)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
        }}
      />

      <div className="w-full max-w-lg">
        <div className="mb-6 text-center">
          <div className="crest mx-auto mb-4 h-16 w-16 text-2xl">H</div>
          <h1 className="font-display text-2xl font-bold text-cream-50" style={{ textShadow: "0 2px 6px rgba(0,0,0,0.4)" }}>
            Halomanage isn&apos;t connected yet
          </h1>
        </div>

        <div className="card space-y-4 text-sm text-stone-700">
          <p>
            This deployment is missing its Supabase project configuration, so nothing past this
            page can work yet. Two environment variables need to be set wherever this app is
            hosted:
          </p>
          <ul className="space-y-2 rounded-lg bg-cream-100 p-3 font-mono text-xs">
            <li><span className="text-royal-700">NEXT_PUBLIC_SUPABASE_URL</span> = https://&lt;your-project-ref&gt;.supabase.co</li>
            <li><span className="text-royal-700">NEXT_PUBLIC_SUPABASE_ANON_KEY</span> = &lt;your project&apos;s anon/public key&gt;</li>
          </ul>
          <p>
            Find both under <strong>Project Settings → API</strong> in the Supabase dashboard. If
            no Supabase project exists yet, create one first and run the migrations in{" "}
            <code className="rounded bg-cream-100 px-1 py-0.5 text-xs">supabase/migrations/</code>{" "}
            — see <code className="rounded bg-cream-100 px-1 py-0.5 text-xs">docs/ROADMAP.md</code>{" "}
            → &quot;First thing to do next&quot; for the exact steps.
          </p>
          <p className="text-xs text-stone-500">
            On Railway specifically: Service → Variables → add both, then redeploy. This page will
            stop appearing (every route falls back to it automatically until then) as soon as
            they&apos;re set — no code change needed.
          </p>
        </div>
      </div>
    </div>
  );
}
