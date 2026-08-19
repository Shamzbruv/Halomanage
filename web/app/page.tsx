import Link from "next/link";

// The public marketing page — what a signed-out visitor sees at the root
// URL. Previously this file just did redirect("/dashboard"), which (via
// middleware bouncing the resulting unauthenticated /dashboard request
// straight to /login) meant there was never anything here to see, and no
// way to find out what Halomanage even is before hitting a login wall.
// Signed-in visitors are sent straight to /dashboard by middleware.ts
// before this component ever renders, so everything below only needs to
// account for a signed-out audience.
const FEATURES = [
  {
    title: "Attendance & time",
    body: "Clock in and out, break tracking, and a live view of who's working right now — no separate time clock hardware.",
  },
  {
    title: "Leave management",
    body: "Configurable leave types and accrual policies, employee requests, and a supervisor approval queue with balances kept in sync automatically.",
  },
  {
    title: "Onboarding",
    body: "Assign a checklist to every new hire — documents, tasks, and sign-off — so nothing falls through in someone's first week.",
  },
  {
    title: "Performance appraisals",
    body: "Recurring review cycles with manager and self-assessment forms, scored and archived against each employee's history.",
  },
  {
    title: "Document vault",
    body: "Contracts, ID, certifications — stored per employee with access controlled the same way every other record is: role by role.",
  },
  {
    title: "Payroll records",
    body: "Halomanage keeps a unified payroll history alongside everything else — imported from whatever payroll provider you already run, never calculated here.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <section
        className="relative overflow-hidden px-4 pb-20 pt-6"
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

        <div className="mx-auto flex max-w-6xl items-center justify-between py-5">
          <div className="flex items-center gap-2.5">
            <span className="crest">H</span>
            <span
              className="font-display text-lg font-bold text-cream-50"
              style={{ textShadow: "0 1px 2px rgba(0,0,0,0.35)" }}
            >
              Halomanage
            </span>
          </div>
          <Link href="/login" className="btn-primary">
            Sign in
          </Link>
        </div>

        <div className="mx-auto mt-14 max-w-3xl text-center">
          <h1
            className="font-display text-4xl font-bold leading-tight text-cream-50 sm:text-5xl"
            style={{ textShadow: "0 2px 8px rgba(0,0,0,0.4)" }}
          >
            One system for your whole employee lifecycle
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base text-royal-200/85 sm:text-lg">
            Attendance, leave, onboarding, performance, documents, and payroll records —
            connected, role-secured, and built on Postgres row-level security instead of
            application-layer guesswork.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link href="/login" className="btn-primary px-6 py-2.5 text-base">
              Sign in
            </Link>
          </div>
          <p className="mt-5 text-xs text-royal-200/60">
            New deployment? Sign in and you&apos;ll be offered the chance to set up your
            organization as its first Admin — no separate signup page required.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16">
        <div className="mb-10 text-center">
          <h2 className="font-display text-2xl font-bold text-stone-900">Everything HR needs, in one place</h2>
          <p className="mt-2 text-sm text-stone-500">
            Halomanage doesn&apos;t calculate payroll — it keeps the record of everything around
            it, so your team stops re-entering the same data in five different tools.
          </p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="card">
              <h3 className="font-display text-base font-bold text-stone-900">{f.title}</h3>
              <p className="mt-2 text-sm text-stone-600">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-gold-200/60 bg-cream-200/50 px-4 py-14">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="font-display text-2xl font-bold text-stone-900">Security-first by design</h2>
          <p className="mt-3 text-sm text-stone-600">
            Every record in Halomanage is protected by Postgres row-level security, not just
            application code — an employee sees their own data, a supervisor sees their team,
            and an Admin sees the organization, enforced at the database itself. Accounts are
            created by invitation from an Admin; there&apos;s no open public signup, which keeps
            uninvited people out of your organization&apos;s data by construction.
          </p>
        </div>
      </section>

      <footer className="px-4 py-8 text-center text-xs text-stone-400">
        <p>Halomanage</p>
      </footer>
    </div>
  );
}
