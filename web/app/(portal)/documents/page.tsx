import Link from "next/link";
import { redirect } from "next/navigation";
import { AcknowledgeDocumentButton } from "@/components/AcknowledgeDocumentButton";
import { DocumentDownloadButton } from "@/components/DocumentDownloadButton";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";

export default async function DocumentsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");
  const supabase = await createClient();
  const { data: documents } = await supabase.from("documents").select("*").order("created_at", { ascending: false });
  const versionIds = (documents ?? []).map((item) => item.current_version_id).filter(Boolean);
  const [{ data: versions }, { data: acknowledgements }] = await Promise.all([
    versionIds.length ? supabase.from("document_versions").select("id, storage_bucket, storage_path, file_name").in("id", versionIds) : Promise.resolve({ data: [] as any[] }),
    versionIds.length ? supabase.from("document_acknowledgements").select("document_version_id").eq("employee_id", session.employee.id) : Promise.resolve({ data: [] as any[] }),
  ]);
  const versionById = new Map((versions ?? []).map((version) => [version.id, version]));
  const acknowledgedIds = new Set((acknowledgements ?? []).map((item) => item.document_version_id));
  const acknowledgementCount = (documents ?? []).filter((item) => item.requires_acknowledgement && item.current_version_id && !acknowledgedIds.has(item.current_version_id)).length;

  return (
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">Your document hub</span><h1>Important files, easy to find.</h1><p>Open contracts, policies, certificates, and HR letters shared with you. Required acknowledgements stay visible until they are complete.</p></div>
      <div className="performance-summary">
        <div className="metric-card"><span className="metric-icon mint"><Icon name="document" /></span><div><small>Available documents</small><strong>{(documents ?? []).length}</strong><em>shared with you</em></div></div>
        <div className="metric-card"><span className="metric-icon sun"><Icon name="check" /></span><div><small>Needs acknowledgement</small><strong>{acknowledgementCount}</strong><em>{acknowledgementCount ? "action required" : "all complete"}</em></div></div>
      </div>
      <section className="card">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="document" /></span><div><h3>My documents</h3><p>Only items you are authorized to see appear here.</p></div></div></div>
        <div className="document-list">
          {(documents ?? []).length === 0 && (
            <div className="context-empty">
              <span><Icon name="document" size={22} /></span>
              <div><strong>Your document hub is ready</strong><p>Policies, contracts, certificates, handbooks, and HR letters will stay organized here as they are published.</p></div>
              {sessionCan(session, "documents.manage_org") && <Link className="btn-secondary" href="/admin/documents">Add the first document</Link>}
            </div>
          )}
          {(documents ?? []).map((document) => {
            const version = document.current_version_id ? versionById.get(document.current_version_id) : null;
            const needsAck = document.requires_acknowledgement && document.current_version_id && !acknowledgedIds.has(document.current_version_id);
            return (
              <article key={document.id}>
                <span className="document-type-icon"><Icon name="document" /></span>
                <div><strong>{document.title}</strong><small>{document.category.replace(/_/g, " ")}{document.expires_on ? ` · Expires ${document.expires_on}` : ""}</small></div>
                <div className="document-actions">{needsAck && <span className="badge badge-gold">Needs acknowledgement</span>}{version && <DocumentDownloadButton bucket={version.storage_bucket} path={version.storage_path} />}{needsAck && document.current_version_id && <AcknowledgeDocumentButton documentVersionId={document.current_version_id} />}</div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
