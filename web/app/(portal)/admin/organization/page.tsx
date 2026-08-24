import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { OrgUnitForm } from "@/components/OrgUnitForm";
import { PositionForm } from "@/components/PositionForm";
import { LocationForm } from "@/components/LocationForm";

// Ref: PRODUCT_BLUEPRINT.md "Organization Structure" — departments, teams,
// locations, positions, reporting lines. Until this page existed, an admin
// had no way to configure any of this without writing SQL by hand.
export default async function OrganizationAdminPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.roles.includes("admin")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const [{ data: orgUnits }, { data: positions }, { data: locations }] = await Promise.all([
    supabase.from("org_units").select("id, name, type, parent_id").eq("organization_id", session.organizationId).order("name"),
    supabase.from("positions").select("id, title, job_code").eq("organization_id", session.organizationId).order("title"),
    supabase.from("locations").select("id, name, city, country_code").eq("organization_id", session.organizationId).order("name"),
  ]);

  const unitById = new Map((orgUnits ?? []).map((u) => [u.id, u]));

  return (
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">Structure & reporting</span><h1>Model how your organization really works.</h1><p>Keep locations, departments, teams, and positions configurable so every workflow follows the right relationships.</p></div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card space-y-4">
          <h2 className="text-sm font-semibold text-stone-900">Departments &amp; teams</h2>
          <ul className="divide-y divide-stone-100">
            {(orgUnits ?? []).length === 0 && <li className="py-2 text-sm text-stone-400">None yet.</li>}
            {(orgUnits ?? []).map((u) => (
              <li key={u.id} className="py-2 text-sm">
                <span className="font-medium text-stone-900">{u.name}</span>{" "}
                <span className="text-xs uppercase text-stone-400">{u.type}</span>
                {u.parent_id && unitById.get(u.parent_id) && (
                  <span className="block text-xs text-stone-500">under {unitById.get(u.parent_id)?.name}</span>
                )}
              </li>
            ))}
          </ul>
          <OrgUnitForm organizationId={session.organizationId} parentOptions={(orgUnits ?? []).map((u) => ({ id: u.id, name: u.name }))} />
        </div>

        <div className="card space-y-4">
          <h2 className="text-sm font-semibold text-stone-900">Positions</h2>
          <ul className="divide-y divide-stone-100">
            {(positions ?? []).length === 0 && <li className="py-2 text-sm text-stone-400">None yet.</li>}
            {(positions ?? []).map((p) => (
              <li key={p.id} className="py-2 text-sm">
                <span className="font-medium text-stone-900">{p.title}</span>{" "}
                {p.job_code && <span className="text-xs text-stone-400">({p.job_code})</span>}
              </li>
            ))}
          </ul>
          <PositionForm organizationId={session.organizationId} />
        </div>

        <div className="card space-y-4">
          <h2 className="text-sm font-semibold text-stone-900">Locations</h2>
          <ul className="divide-y divide-stone-100">
            {(locations ?? []).length === 0 && <li className="py-2 text-sm text-stone-400">None yet.</li>}
            {(locations ?? []).map((l) => (
              <li key={l.id} className="py-2 text-sm">
                <span className="font-medium text-stone-900">{l.name}</span>{" "}
                <span className="text-xs text-stone-400">{[l.city, l.country_code].filter(Boolean).join(", ")}</span>
              </li>
            ))}
          </ul>
          <LocationForm organizationId={session.organizationId} />
        </div>
      </div>
    </div>
  );
}
