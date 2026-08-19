import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { DocumentDownloadButton } from "@/components/DocumentDownloadButton";
import { AcknowledgeDocumentButton } from "@/components/AcknowledgeDocumentButton";

export default async function DocumentsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) return null;

  const supabase = await createClient();

  // RLS (can_see_document) already scopes this to what this employee is
  // entitled to see: their own docs, org-wide docs, and anything explicitly
  // shared with their team.
  const { data: documents } = await supabase.from("documents").select("*").order("created_at", { ascending: false });

  const versionIds = (documents ?? []).map((d) => d.current_version_id).filter(Boolean);
  const [{ data: versions }, { data: acks }] = await Promise.all([
    versionIds.length
      ? supabase.from("document_versions").select("id, storage_bucket, storage_path, file_name").in("id", versionIds)
      : Promise.resolve({ data: [] as any[] }),
    versionIds.length
      ? supabase.from("document_acknowledgements").select("document_version_id").eq("employee_id", session.employee.id)
      : Promise.resolve({ data: [] as any[] }),
  ]);

  const versionById = new Map((versions ?? []).map((v) => [v.id, v]));
  const acknowledgedVersionIds = new Set((acks ?? []).map((a) => a.document_version_id));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-lg font-semibold text-stone-900">Documents</h1>

      <div className="card">
        <ul className="divide-y divide-stone-100">
          {(documents ?? []).length === 0 && <li className="py-3 text-sm text-stone-400">No documents yet.</li>}
          {(documents ?? []).map((d) => {
            const v = d.current_version_id ? versionById.get(d.current_version_id) : null;
            const needsAck = d.requires_acknowledgement && d.current_version_id && !acknowledgedVersionIds.has(d.current_version_id);
            return (
              <li key={d.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div>
                  <p className="font-medium text-stone-900">{d.title}</p>
                  <p className="text-xs text-stone-500">{d.category.replace(/_/g, " ")}{d.expires_on && ` · expires ${d.expires_on}`}</p>
                </div>
                <div className="flex items-center gap-2">
                  {needsAck && <span className="badge badge-gold">Needs acknowledgement</span>}
                  {v && <DocumentDownloadButton bucket={v.storage_bucket} path={v.storage_path} />}
                  {needsAck && d.current_version_id && <AcknowledgeDocumentButton documentVersionId={d.current_version_id} />}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
