import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { DocumentUploadForm } from "@/components/DocumentUploadForm";
import { DocumentDownloadButton } from "@/components/DocumentDownloadButton";
import { FulfillDocumentRequestForm } from "@/components/FulfillDocumentRequestForm";
import { RejectDocumentRequestButton } from "@/components/RejectDocumentRequestButton";
import { requestTypeLabel } from "@/lib/documentRequests";
import { formatDate } from "@/lib/timezone";
import { statusBadgeClass } from "@/lib/ui";

export default async function DocumentsAdminPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "documents.manage_org")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const orgId = session.organizationId;

  const [{ data: documents }, { data: employees }, { data: documentRequests }] = await Promise.all([
    supabase.from("documents").select("*").eq("organization_id", orgId).order("created_at", { ascending: false }),
    supabase.from("employees").select("id, first_name, last_name").eq("organization_id", orgId).order("last_name"),
    supabase.from("document_requests").select("*").eq("organization_id", orgId).order("requested_at", { ascending: false }),
  ]);

  const employeeById = new Map((employees ?? []).map((e) => [e.id, e]));
  const versionIds = (documents ?? []).map((d) => d.current_version_id).filter(Boolean);
  const { data: versions } = versionIds.length
    ? await supabase.from("document_versions").select("id, storage_bucket, storage_path, file_name").in("id", versionIds)
    : { data: [] as any[] };
  const versionById = new Map((versions ?? []).map((v) => [v.id, v]));
  const pendingRequestCount = (documentRequests ?? []).filter((r) => r.status === "submitted").length;

  return (
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">Document administration</span><h1>Share the right file with the right people.</h1><p>Manage versions, visibility, expiry, and employee acknowledgements from one secure library.</p></div>

      <div className="card overflow-x-auto">
        <div className="mb-3 flex items-center gap-2"><h2 className="text-sm font-semibold text-stone-900">Document requests</h2>{pendingRequestCount > 0 && <span className="badge badge-gold">{pendingRequestCount} pending</span>}</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400">
              <th className="pb-2">Employee</th>
              <th className="pb-2">Requesting</th>
              <th className="pb-2">Purpose</th>
              <th className="pb-2">Requested</th>
              <th className="pb-2">Status</th>
              <th className="pb-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {(documentRequests ?? []).length === 0 && (
              <tr><td colSpan={6} className="py-4 text-stone-400">No document requests yet.</td></tr>
            )}
            {(documentRequests ?? []).map((request) => {
              const employee = employeeById.get(request.employee_id);
              const employeeName = employee ? `${employee.first_name} ${employee.last_name}` : "Former employee";
              const typeLabel = requestTypeLabel(request.request_type, request.request_type_other_label);
              return (
                <tr key={request.id}>
                  <td className="py-2 font-medium text-stone-900">{employeeName}</td>
                  <td className="py-2 text-stone-500">{typeLabel}</td>
                  <td className="py-2 text-stone-500">{request.purpose ?? "—"}</td>
                  <td className="py-2 text-stone-500">{formatDate(request.requested_at, session.organization?.timezone)}</td>
                  <td className="py-2"><span className={`badge ${statusBadgeClass(request.status)}`}>{request.status === "rejected" && request.rejection_reason ? `declined: ${request.rejection_reason}` : request.status}</span></td>
                  <td className="py-2 text-right">
                    {request.status === "submitted" && (
                      <span className="flex items-center justify-end gap-2">
                        <FulfillDocumentRequestForm
                          requestId={request.id}
                          organizationId={orgId}
                          employeeId={request.employee_id}
                          employeeName={employeeName}
                          defaultTitle={`${typeLabel} — ${employeeName}`}
                        />
                        <RejectDocumentRequestButton requestId={request.id} employeeName={employeeName} />
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

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
