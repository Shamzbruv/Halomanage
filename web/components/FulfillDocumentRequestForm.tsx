"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";

// Ref: components/DocumentUploadForm.tsx — same storage bucket and path
// convention, same three-write sequence (upload, insert documents, insert
// document_versions), just always category 'hr_letter' / visibility 'self'
// for this employee, and finished by fulfill_document_request() linking the
// new document back to the request (20260906100000_document_requests.sql).
export function FulfillDocumentRequestForm({
  requestId,
  organizationId,
  employeeId,
  employeeName,
  defaultTitle,
}: {
  requestId: string;
  organizationId: string;
  employeeId: string;
  employeeName: string;
  defaultTitle: string;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(defaultTitle);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setLoading(true);
    setError(null);

    const bucket = "employee-documents";
    const path = `${organizationId}/${employeeId}/hr_letter/${Date.now()}-${file.name}`;

    const { error: uploadError } = await supabase.storage.from(bucket).upload(path, file, {
      contentType: file.type || "application/octet-stream",
    });
    if (uploadError) {
      setError(uploadError.message);
      setLoading(false);
      return;
    }

    const { data: doc, error: docError } = await supabase
      .from("documents")
      .insert({ organization_id: organizationId, employee_id: employeeId, category: "hr_letter", title, visibility: "self" })
      .select()
      .single();
    if (docError || !doc) {
      setError(docError?.message ?? "Failed to create document record");
      setLoading(false);
      return;
    }

    const { data: version, error: versionError } = await supabase
      .from("document_versions")
      .insert({ document_id: doc.id, version_number: 1, storage_bucket: bucket, storage_path: path, file_name: file.name, mime_type: file.type || null, file_size: file.size })
      .select()
      .single();
    if (versionError || !version) {
      setError(versionError?.message ?? "Failed to record document version");
      setLoading(false);
      return;
    }

    await supabase.from("documents").update({ current_version_id: version.id }).eq("id", doc.id);

    const { error: fulfillError } = await supabase.rpc("fulfill_document_request", { p_request_id: requestId, p_document_id: doc.id });
    if (fulfillError) {
      setError(`File uploaded, but marking the request fulfilled failed: ${fulfillError.message}. The document is still saved — try again or fulfill it manually from Document library.`);
      setLoading(false);
      return;
    }

    setOpen(false);
    setFile(null);
    setLoading(false);
    router.refresh();
  }

  return (
    <>
      <button type="button" className="btn-primary px-3 py-1.5 text-xs" onClick={() => setOpen(true)}>Fulfill</button>
      {open && (
        <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby={`fulfill-title-${requestId}`}>
          <button className="modal-backdrop" type="button" aria-label="Close" onClick={() => setOpen(false)} />
          <form className="modal-card" onSubmit={handleSubmit}>
            <div className="modal-head">
              <div><span className="eyebrow">Fulfill request</span><h3 id={`fulfill-title-${requestId}`}>Upload {employeeName}&apos;s document</h3><p>This creates the file in their Documents hub and marks the request fulfilled.</p></div>
              <button className="icon-button" type="button" aria-label="Close" onClick={() => setOpen(false)}><Icon name="x" /></button>
            </div>
            <div><label className="label" htmlFor={`fulfill-title-input-${requestId}`}>Document title</label><input id={`fulfill-title-input-${requestId}`} required className="input" value={title} onChange={(event) => setTitle(event.target.value)} /></div>
            <div><label className="label" htmlFor={`fulfill-file-${requestId}`}>File</label><input id={`fulfill-file-${requestId}`} required type="file" className="input" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></div>
            {error && <p className="alert-error" role="alert">{error}</p>}
            <div className="modal-actions"><button className="btn-secondary" type="button" onClick={() => setOpen(false)}>Cancel</button><button className="btn-primary" disabled={loading || !file} type="submit">{loading ? "Uploading…" : "Upload & fulfill"}</button></div>
          </form>
        </div>
      )}
    </>
  );
}
