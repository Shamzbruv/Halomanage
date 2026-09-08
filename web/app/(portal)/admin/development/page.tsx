import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { NewTrainingCourseForm } from "@/components/NewTrainingCourseForm";
import { NewAssetForm } from "@/components/NewAssetForm";
import { ToggleActiveButton } from "@/components/ToggleActiveButton";

// The catalog counterpart to the employee-facing (portal)/development page,
// which has always rendered training/certifications/assets it was given but
// had no admin screen anywhere that could actually populate them (see
// 20260818001400_training_assets.sql — the schema, RLS, and training.manage/
// assets.manage permissions all existed; this was the missing UI, tracked
// as ROADMAP.md item 2). Assigning a course or asset to one specific
// employee happens on that employee's own detail page, not here — this page
// is only the shared catalog, the same split /admin/compensation-settings
// already draws between structure and one person's Change Compensation.
export default async function DevelopmentAdminPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.organizationId) redirect("/dashboard");
  const canManageTraining = sessionCan(session, "training.manage");
  const canManageAssets = sessionCan(session, "assets.manage");
  if (!canManageTraining && !canManageAssets) redirect("/dashboard");

  const supabase = await createClient();
  const orgId = session.organizationId;

  const [{ data: courses }, { data: assets }, { data: openAssignments }] = await Promise.all([
    canManageTraining
      ? supabase.from("training_courses").select("*").eq("organization_id", orgId).order("name")
      : Promise.resolve({ data: null }),
    canManageAssets
      ? supabase.from("assets").select("*").eq("organization_id", orgId).order("name")
      : Promise.resolve({ data: null }),
    canManageAssets
      ? supabase.from("employee_asset_assignments").select("asset_id").eq("organization_id", orgId).is("returned_at", null)
      : Promise.resolve({ data: null }),
  ]);
  const assignedAssetIds = new Set((openAssignments ?? []).map((a) => a.asset_id));

  return (
    <div className="space-y-6">
      <div className="page-intro">
        <span className="eyebrow">Learning &amp; assets</span>
        <h1>Build the catalog HR assigns from.</h1>
        <p>Courses and equipment created here become options on every employee&apos;s own record — nothing shows up for anyone until it exists here first.</p>
      </div>

      {canManageTraining && (
        <div className="card overflow-x-auto">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div><h2 className="text-sm font-semibold text-stone-900">Training courses</h2><p className="text-xs text-stone-500">Assign one to a specific employee from their own People record.</p></div>
            <NewTrainingCourseForm organizationId={orgId} />
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400">
                <th className="pb-2">Name</th>
                <th className="pb-2">Required</th>
                <th className="pb-2">Renews</th>
                <th className="pb-2">Status</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {(courses ?? []).length === 0 && (
                <tr><td colSpan={5} className="py-4 text-stone-400">No training courses yet — create one above.</td></tr>
              )}
              {(courses ?? []).map((c) => (
                <tr key={c.id}>
                  <td className="py-2 font-medium text-stone-900">{c.name}{c.description && <p className="text-xs font-normal text-stone-500">{c.description}</p>}</td>
                  <td className="py-2">{c.is_required ? "Yes" : "No"}</td>
                  <td className="py-2">{c.validity_months ? `Every ${c.validity_months} mo.` : "No expiry"}</td>
                  <td className="py-2">{c.is_active ? "Active" : "Inactive"}</td>
                  <td className="py-2 text-right"><ToggleActiveButton table="training_courses" id={c.id} isActive={c.is_active} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManageAssets && (
        <div className="card overflow-x-auto">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div><h2 className="text-sm font-semibold text-stone-900">Equipment &amp; assets</h2><p className="text-xs text-stone-500">Assign or take back one item from a specific employee&apos;s own People record.</p></div>
            <NewAssetForm organizationId={orgId} />
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400">
                <th className="pb-2">Name</th>
                <th className="pb-2">Category</th>
                <th className="pb-2">Serial / ID</th>
                <th className="pb-2">Currently assigned</th>
                <th className="pb-2">Status</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {(assets ?? []).length === 0 && (
                <tr><td colSpan={6} className="py-4 text-stone-400">No assets recorded yet — create one above.</td></tr>
              )}
              {(assets ?? []).map((a) => (
                <tr key={a.id}>
                  <td className="py-2 font-medium text-stone-900">{a.name}</td>
                  <td className="py-2">{a.category.replace(/_/g, " ")}</td>
                  <td className="py-2">{a.serial_number ?? "—"}</td>
                  <td className="py-2">{assignedAssetIds.has(a.id) ? "Yes" : "No"}</td>
                  <td className="py-2">{a.is_active ? "Active" : "Inactive"}</td>
                  <td className="py-2 text-right"><ToggleActiveButton table="assets" id={a.id} isActive={a.is_active} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
