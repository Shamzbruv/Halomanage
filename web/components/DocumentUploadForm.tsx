"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Ref: ARCHITECTURE.md "Documents and e-signatures" — PostgreSQL owns
// metadata/authorization here, Storage owns the binary. An org-wide
// document (no employee selected) goes to the company-policies bucket;
// an employee-specific one goes to employee-documents, path-scoped so
// Storage RLS (20260818001700_storage.sql) can enforce who can read it
// purely from the path.
export function DocumentUploadForm({
  organizationId,
  employees,
}: {
  organizationId: string;
  employees: { id: string; label: string }[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("policy");
  const [employeeId, setEmployeeId] = useState("");
  const [visibility, setVisibility] = useState("org");
  const [requiresAck, setRequiresAck] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setError(null);

    const bucket = employeeId ? "employee-documents" : "company-policies";
    const path = employeeId
      ? `${organizationId}/${employeeId}/${category}/${Date.now()}-${file.name}`
      : `${organizationId}/${Date.now()}-${file.name}`;

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
      .insert({
        organization_id: organizationId,
        employee_id: employeeId || null,
        category,
        title,
        visibility: employeeId ? visibility : "org",
        requires_acknowledgement: requiresAck,
      })
      .select()
      .single();
    if (docError || !doc) {
      setError(docError?.message ?? "Failed to create document record");
      setLoading(false);
      return;
    }

    const { data: version, error: versionError } = await supabase
      .from("document_versions")
      .insert({
        document_id: doc.id,
        version_number: 1,
        storage_bucket: bucket,
        storage_path: path,
        file_name: file.name,
        mime_type: file.type || null,
        file_size: file.size,
      })
      .select()
      .single();
    if (versionError || !version) {
      setError(versionError?.message ?? "Failed to record document version");
      setLoading(false);
      return;
    }

    await supabase.from("documents").update({ current_version_id: version.id }).eq("id", doc.id);

    setTitle("");
    setFile(null);
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Title</label>
          <input required className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <label className="label">Category</label>
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="policy">Policy</option>
            <option value="contract">Contract</option>
            <option value="identification">Identification</option>
            <option value="certificate">Certificate</option>
            <option value="hr_letter">HR letter</option>
            <option value="medical">Medical</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <label className="label">Employee (leave blank for org-wide)</label>
          <select className="input" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Org-wide (everyone)</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        </div>
        {employeeId && (
          <div>
            <label className="label">Visibility</label>
            <select className="input" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="self">Employee + HR</option>
              <option value="team">+ their Supervisor/Manager</option>
              <option value="hr_only">HR only</option>
            </select>
          </div>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm text-stone-600">
        <input type="checkbox" checked={requiresAck} onChange={(e) => setRequiresAck(e.target.checked)} /> Requires acknowledgement
      </label>
      <div>
        <label className="label">File</label>
        <input required type="file" className="input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={loading || !file} className="btn-primary">
        {loading ? "Uploading…" : "Upload document"}
      </button>
    </form>
  );
}
