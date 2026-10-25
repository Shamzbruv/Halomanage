"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function LeaveDecisionButtons({ leaveRequestId, cancellation = false }: { leaveRequestId: string; cancellation?: boolean }) {
  const router = useRouter(); const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function decide(approve: boolean) {
    setBusy(true); setError(null);
    const { error } = await createClient().rpc(cancellation ? "decide_leave_cancellation" : "decide_leave_request", { p_leave_request_id: leaveRequestId, p_approve: approve, p_note: note.trim() || null });
    setBusy(false); if (error) setError(error.message); else { setNote(""); router.refresh(); }
  }
  return <div className="space-y-2"><input className="input" aria-label="Leave decision reason" placeholder={cancellation ? "Reason / confirm whether leave was taken" : "Review note (required to reject)"} value={note} maxLength={1000} onChange={e => setNote(e.target.value)} /><div className="flex flex-wrap gap-2"><button className="btn-primary" disabled={busy || (cancellation && !note.trim())} onClick={() => decide(true)}>{cancellation ? "Approve cancellation" : "Approve this step"}</button><button className="btn-danger" disabled={busy || !note.trim()} onClick={() => decide(false)}>{cancellation ? "Decline cancellation" : "Reject with reason"}</button></div>{error && <p role="alert" className="alert-error">{error}</p>}</div>;
}

export function LeaveRequestActions({ id, status, cancellationPending, canReroute, attachment }: { id: string; status: string; cancellationPending: boolean; canReroute: boolean; attachment?: { path: string; name: string } | null }) {
  const router = useRouter(); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  async function act(reroute: boolean) {
    setBusy(true); setError(null);
    const { error } = await createClient().rpc(reroute ? "reroute_leave_request" : "request_leave_cancellation", { p_leave_request_id: id, ...(reroute ? { p_note: note } : { p_reason: note || null }) });
    setBusy(false); if (error) setError(error.message); else router.refresh();
  }
  return <div className="space-y-3">
    {attachment && <button className="btn-secondary" disabled={busy} onClick={async () => { setBusy(true); const { data, error } = await createClient().storage.from("leave-attachments").createSignedUrl(attachment.path, 60); setBusy(false); if (error) setError(error.message); else if (data?.signedUrl) setDownloadUrl(data.signedUrl); }}>Prepare private document: {attachment.name}</button>}
    {downloadUrl && <p><a className="table-action" href={downloadUrl} target="_blank" rel="noopener noreferrer">Open supporting document</a><small className="block">This private link expires in 60 seconds. Prepare a new link if needed.</small></p>}
    {(status === "approved" || status.startsWith("pending") || status === "submitted" || canReroute) && <><label className="label" htmlFor="leave-action-reason">Reason</label><input id="leave-action-reason" className="input" value={note} maxLength={1000} onChange={e => setNote(e.target.value)} />
      {canReroute ? <button className="btn-secondary" disabled={busy || !note.trim()} onClick={() => act(true)}>Reroute pending steps to HR</button> : <button className="btn-secondary" disabled={busy || cancellationPending || (status === "approved" && !note.trim())} onClick={() => act(false)}>{cancellationPending ? "Cancellation awaiting review" : status === "approved" ? "Request cancellation" : "Withdraw pending request"}</button>}
      {status === "approved" && !canReroute && <p className="field-help">Approved leave remains in force until cancellation is reviewed. Balance is returned only after approval. If the dates have passed, HR must confirm whether the leave was actually taken.</p>}</>}
    {error && <p role="alert" className="alert-error">{error}</p>}
  </div>;
}
