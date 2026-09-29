"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Completion stores real evidence: a note goes into completion_data (never
// base64 files — those live in the document system and are linked through
// attach_onboarding_task_document()).
export function OnboardingTaskActions({
  taskId,
  canSkip,
  documents,
}: {
  taskId: string;
  canSkip: boolean;
  documents: { id: string; title: string }[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "complete" | "skip">("idle");
  const [note, setNote] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    if (documentId) {
      const { error: attachError } = await supabase.rpc("attach_onboarding_task_document", { p_task_id: taskId, p_document_id: documentId });
      if (attachError) {
        setError(attachError.message);
        setLoading(false);
        return;
      }
    }
    const { error: rpcError } = mode === "skip"
      ? await supabase.rpc("skip_onboarding_task", { p_task_id: taskId, p_reason: note })
      : await supabase.rpc("complete_onboarding_task", {
          p_task_id: taskId,
          p_completion_data: note.trim() || documentId ? { notes: note.trim() || null, document_ids: documentId ? [documentId] : [] } : null,
        });
    if (rpcError) {
      setError(rpcError.message);
      setLoading(false);
      return;
    }
    setLoading(false);
    setMode("idle");
    setNote("");
    setDocumentId("");
    router.refresh();
  }

  if (mode === "idle") {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setMode("complete")}>Mark complete</button>
        {canSkip && <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setMode("skip")}>Skip</button>}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-2 rounded-lg border border-stone-200 bg-white p-2.5">
      <label className="label" htmlFor={`task-note-${taskId}`}>{mode === "skip" ? "Why is this step being skipped?" : "Note (optional)"}</label>
      <textarea id={`task-note-${taskId}`} rows={2} required={mode === "skip"} className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === "skip" ? "e.g. Not applicable to contractors" : "e.g. Orientation done; needs extra Excel training"} />
      {mode === "complete" && documents.length > 0 && (
        <div>
          <label className="label" htmlFor={`task-doc-${taskId}`}>Attach a document from their record (optional)</label>
          <select id={`task-doc-${taskId}`} className="input" value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
            <option value="">None</option>
            {documents.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
          </select>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-ruby-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary px-3 py-1 text-xs" disabled={loading}>{loading ? "Saving…" : mode === "skip" ? "Skip step" : "Complete step"}</button>
        <button type="button" className="btn-secondary px-3 py-1 text-xs" onClick={() => setMode("idle")}>Cancel</button>
      </div>
    </form>
  );
}

export function CancelOnboardingRunButton({ runId }: { runId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    const reason = window.prompt("Why is this onboarding being cancelled? The record and every completed step are kept.");
    if (!reason) return;
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("cancel_onboarding_run", { p_run_id: runId, p_reason: reason });
    if (rpcError) setError(rpcError.message);
    setLoading(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={loading} onClick={cancel}>{loading ? "Cancelling…" : "Cancel onboarding"}</button>
      {error && <span className="text-xs text-ruby-600">{error}</span>}
    </div>
  );
}
