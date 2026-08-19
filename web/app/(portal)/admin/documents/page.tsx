import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { DocumentUploadForm } from "@/components/DocumentUploadForm";
import { DocumentDownloadButton } from "@/components/DocumentDownloadButton";

export default async function DocumentsAdminPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.roles.includes("admin")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const orgId = session.organizationId;

  const [{ data: documents }, { data: employees }] = await Promise.all([
    supabase.from("documents").select("*").eq("organization_id", orgId).order("created_at", { ascending: false }),
    supabase.from("employees").select("id, first_name, last_name").eq("organization_id", orgId).order("last_name"),
  ]);

  const employeeById = new Map((employees ?? []).map((e) => [e.id, e]));
  const versionIds = (documents ?? []).map((d) => d.current_version_id).filter(Boolean);
  const { data: versions } = versionIds.length
    ? await supabase.from("document_versions").select("id, storage_bucket, storage_path, file_name").in("id", versionIds)
    : { data: [] as any[] };
  const versionById = new Map((versions ?? []).map((v) => [v.id, v]));

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-stone-900">Documents</h1>

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Upload</h2>
        <DocumentUploadForm organizationId={orgId} employees={(employees ?? []).map((e) => ({ id: e.id, label: `${e.first_name} ${e.last_name}` }))} />
      </div>

      <div className="card overflow-x-auto">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">All documents</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400">
              <th className="pb-2">Title</th>
              <th className="pb-2">Category</th>
              <th className="pb-2">Employee</th>
              <th className="pb-2">Visibility</th>
              <th className="pb-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {(documents ?? []).length === 0 && (
              <tr><td colSpan={5} className="py-4 text-stone-400">No documents yet.</td></tr>
            )}
            {(documents ?? []).map((d) => {
              const v = d.current_version_id ? versionById.get(d.current_version_id) : null;
              const emp = d.employee_id ? employeeById.get(d.employee_id) : null;
              return (
                <tr key={d.id}>
                  <td className="py-2 font-medium text-stone-900">{d.title}</td>
                  <td className="py-2 text-stone-500">{d.category.replace(/_/g, " ")}</td>
                  <td className="py-2 text-stone-500">{emp ? `${emp.first_name} ${emp.last_name}` : "Org-wide"}</td>
                  <td className="py-2 text-stone-500">{d.visibility}</td>
                  <td className="py-2">{v && <DocumentDownloadButton bucket={v.storage_bucket} path={v.storage_path} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
