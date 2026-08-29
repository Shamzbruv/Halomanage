import { redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { GiveRecognitionForm } from "@/components/rewards/GiveRecognitionForm";

function fullName(person: { first_name?: string | null; last_name?: string | null } | null | undefined) {
  if (!person) return "A coworker";
  return [person.first_name, person.last_name].filter(Boolean).join(" ") || "A coworker";
}

export default async function RecognitionPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");
  if (!sessionCan(session, "recognition.give")) redirect("/dashboard");

  const supabase = await createClient();
  const employeeId = session.employee.id;
  const orgId = session.organizationId;
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [{ data: settings }, { data: coworkers }, { data: values }, { data: givenThisMonth }, { data: feed }] = await Promise.all([
    supabase.from("organization_recognition_settings").select("monthly_point_allowance, max_points_per_recognition, default_visibility").eq("organization_id", orgId).maybeSingle(),
    supabase.from("employees").select("id, first_name, last_name").eq("organization_id", orgId).eq("status", "active").neq("id", employeeId).order("first_name"),
    supabase.from("recognition_values").select("id, name").eq("organization_id", orgId).eq("is_active", true).order("name"),
    supabase.from("recognitions").select("points_given").eq("giver_employee_id", employeeId).gte("created_at", startOfMonth.toISOString()),
    supabase
      .from("recognitions")
      .select("id, message, points_given, visibility, created_at, giver:giver_employee_id(first_name, last_name), recipient:recipient_employee_id(first_name, last_name), recognition_values(name)")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(30),
  ]);

  const monthlyAllowance = settings?.monthly_point_allowance ?? 0;
  const maxPointsPerRecognition = settings?.max_points_per_recognition ?? null;
  const defaultVisibility = (settings?.default_visibility ?? "public") as "public" | "private";
  const givenSoFar = (givenThisMonth ?? []).reduce((sum, r) => sum + r.points_given, 0);
  const remainingAllowance = Math.max(monthlyAllowance - givenSoFar, 0);

  return (
    <div className="space-y-6">
      <div className="page-intro">
        <span className="eyebrow">Recognition</span>
        <h1>Say something good.</h1>
        <p>Recognize a coworker for what they did — with or without points, depending on your organization&apos;s policy.</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 card">
        <div className="flex gap-6">
          {monthlyAllowance > 0 && (
            <div><small className="block text-xs uppercase text-stone-400">Your giving allowance this month</small><strong className="text-lg text-stone-900">{remainingAllowance.toLocaleString()} / {monthlyAllowance.toLocaleString()}</strong></div>
          )}
          {monthlyAllowance === 0 && (
            <p className="text-sm text-stone-500">Recognition is kudos-only right now — no points attached, just a message that shows people were noticed.</p>
          )}
        </div>
        <GiveRecognitionForm
          coworkers={(coworkers ?? []).map((c) => ({ id: c.id, label: `${c.first_name} ${c.last_name}` }))}
          values={values ?? []}
          monthlyAllowance={monthlyAllowance}
          remainingAllowance={remainingAllowance}
          maxPointsPerRecognition={maxPointsPerRecognition}
          defaultVisibility={defaultVisibility}
        />
      </div>

      <section className="card overflow-x-auto">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Recent recognition</h2>
        {(feed ?? []).length === 0 ? (
          <div className="context-empty"><span><Icon name="spark" size={22} /></span><div><strong>No recognition yet</strong><p>Be the first to recognize a coworker.</p></div></div>
        ) : (
          <div className="resource-list">
            {(feed ?? []).map((item: any) => (
              <article key={item.id}>
                <span className="metric-icon sun small"><Icon name="spark" size={16} /></span>
                <div>
                  <strong>{fullName(item.giver)} → {fullName(item.recipient)}</strong>
                  <p>{item.message}</p>
                  <small>
                    {item.recognition_values?.name ? `${item.recognition_values.name} · ` : ""}
                    {new Date(item.created_at).toLocaleDateString()}
                    {item.visibility === "private" ? " · Private" : ""}
                  </small>
                </div>
                {item.points_given > 0 && <span className="badge badge-gold">+{item.points_given.toLocaleString()} pts</span>}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
