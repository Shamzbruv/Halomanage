"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { LeaveType } from "@/lib/supabase/types";

type Preview = { total_days: number; basis: string; available: number; balance_tracked: boolean; requires_attachment: boolean; requires_approval: boolean; paid: boolean; days: { work_date: string; day_fraction: number; scheduled_minutes: number }[] };
export function LeaveRequestForm({ leaveTypes, organizationId, employeeId }: { leaveTypes: LeaveType[]; organizationId: string; employeeId: string }) {
  const router = useRouter();
  const [type, setType] = useState(leaveTypes[0]?.id ?? "");
  const [start, setStart] = useState(""); const [end, setEnd] = useState("");
  const [part, setPart] = useState("full"); const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null); const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ signature: string; data: Preview } | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const selected = leaveTypes.find(t => t.id === type);
  const half = part !== "full";
  const signature = JSON.stringify([type, start, half ? start : end, half]);
  const current = preview?.signature === signature ? preview.data : null;
  const args = { p_leave_type_id: type, p_start_date: start, p_end_date: half ? start : end, p_half_day: half };
  async function review() {
    setBusy(true); setError(null);
    try {
      const { data, error } = await createClient().rpc("preview_leave", args);
      if (error) throw error;
      setPreview({ signature, data: data as Preview });
    } catch (e) { setError((e as { message?: string }).message ?? "Unable to review leave."); }
    finally { setBusy(false); }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (!current) return;
    setBusy(true); setError(null);
    try {
      const client = createClient(); let id = attachmentId;
      if (file && !id) {
        if (file.size > 10485760 || !["application/pdf", "image/jpeg", "image/png"].includes(file.type)) throw new Error("Choose a PDF, JPG or PNG up to 10 MB.");
        const ext = file.type === "application/pdf" ? "pdf" : file.type === "image/png" ? "png" : "jpg";
        const path = `${organizationId}/${employeeId}/${crypto.randomUUID()}.${ext}`;
        const upload = await client.storage.from("leave-attachments").upload(path, file, { contentType: file.type, upsert: false });
        if (upload.error) throw upload.error;
        const registered = await client.rpc("register_leave_attachment", { p_storage_path: path, p_file_name: file.name });
        if (registered.error) throw registered.error;
        id = registered.data; setAttachmentId(id);
      }
      if (current.requires_attachment && !id) throw new Error("Your leave policy requires a supporting document.");
      const { data, error } = await client.rpc("submit_leave_request", { ...args, p_reason: reason.trim() || null, p_attachment_document_id: id, p_day_part: part, p_client_request_id: key });
      if (error) throw error;
      setKey(crypto.randomUUID()); router.push(`/leave/${data.id}`); router.refresh();
    } catch (e) { setError((e as { message?: string }).message ?? "Unable to submit leave. You can safely retry."); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="card space-y-4">
    <h2 className="text-lg font-semibold">Request leave</h2>
    <div><label className="label" htmlFor="leave-type">Leave type</label><select id="leave-type" className="input" value={type} onChange={e => { setType(e.target.value); setPart("full"); setKey(crypto.randomUUID()); }}>{leaveTypes.map(t => <option key={t.id} value={t.id}>{t.name}{t.is_paid ? "" : " (unpaid)"}</option>)}</select></div>
    <div className="grid grid-cols-2 gap-3"><div><label className="label" htmlFor="leave-start">First day</label><input id="leave-start" className="input" type="date" required value={start} onChange={e => { setStart(e.target.value); setKey(crypto.randomUUID()); }} /></div><div><label className="label" htmlFor="leave-end">Last day</label><input id="leave-end" className="input" type="date" required min={start} disabled={half} value={half ? start : end} onChange={e => { setEnd(e.target.value); setKey(crypto.randomUUID()); }} /></div></div>
    {selected?.allow_half_day && <div><label className="label" htmlFor="leave-part">Duration</label><select id="leave-part" className="input" value={part} onChange={e => { setPart(e.target.value); setKey(crypto.randomUUID()); }}><option value="full">Full day(s)</option><option value="am">First half of the scheduled shift</option><option value="pm">Second half of the scheduled shift</option></select><p className="field-help">Half-days use one date, including an overnight shift&apos;s start date.</p></div>}
    <p className="field-help">Dates use your organization&apos;s calendar. Review shows the days charged after your schedule and applicable holidays are checked.</p>
    <button className="btn-secondary w-full" type="button" disabled={busy || !start || (!half && !end)} onClick={review}>{busy ? "Working…" : "Review dates & balance"}</button>
    {current && <div className="rounded-xl bg-cream-100 p-4 space-y-2" aria-live="polite"><strong>{current.total_days} {current.basis === "calendar_days" ? "calendar" : "scheduled working"} day(s) · {current.paid ? "paid" : "unpaid"}</strong><p>{current.balance_tracked ? `${current.available} days available after pending reservations` : "Balance is not tracked for this leave type"}</p><p className="field-help">{current.requires_approval ? "Pending requests reserve days. Your time off is confirmed only after final approval." : "This leave type is configured for automatic approval."}</p><details><summary className="cursor-pointer">Days that will be charged</summary><ul className="text-sm mt-2 max-h-48 overflow-y-auto">{current.days.map(d => <li key={d.work_date}>{d.work_date} · {d.day_fraction} day · {((d.day_fraction === 0.5 ? (part === "am" ? Math.floor(d.scheduled_minutes / 2) : Math.ceil(d.scheduled_minutes / 2)) : d.scheduled_minutes) / 60).toFixed(2)} scheduled hours</li>)}</ul></details></div>}
    <div><label className="label" htmlFor="leave-reason">Reason (required for backdated leave)</label><textarea id="leave-reason" className="input" maxLength={2000} rows={3} value={reason} onChange={e => { setReason(e.target.value); setKey(crypto.randomUUID()); }} /><p className="field-help">Share only what your reviewer needs. Supporting medical details can go in the private attachment.</p></div>
    <div><label className="label" htmlFor="leave-file">Supporting document {current?.requires_attachment ? "(required)" : "(optional)"}</label><input id="leave-file" className="input" type="file" accept="application/pdf,image/png,image/jpeg" onChange={e => { setFile(e.target.files?.[0] ?? null); setAttachmentId(null); setKey(crypto.randomUUID()); }} /><p className="field-help">Private PDF, JPG or PNG, maximum 10 MB. Visible to you and authorized leave reviewers.</p></div>
    {error && <p className="alert-error" role="alert">{error}</p>}
    <button className="btn-primary w-full" disabled={busy || !current || (current.requires_attachment && !file && !attachmentId)}>{busy ? "Working…" : "Submit reviewed request"}</button>
  </form>;
}
