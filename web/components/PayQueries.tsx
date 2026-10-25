"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
export type PayQuery = {
  id: string;
  employee_id: string;
  payslip_id: string | null;
  category: string;
  subject: string;
  status: string;
  resolution_payslip_id: string | null;
  created_at: string;
  pay_query_messages: {
    id: string;
    body: string;
    is_hr: boolean;
    created_at: string;
  }[];
};
export function NewPayQuery({
  canComp,
  canPay,
  payslipId,
}: {
  canComp: boolean;
  canPay: boolean;
  payslipId?: string;
}) {
  const router = useRouter(),
    key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    key.current ??= crypto.randomUUID();
    const f = new FormData(e.currentTarget);
    const { error } = await createClient().rpc("submit_pay_query", {
      p_category: String(f.get("category")),
      p_subject: String(f.get("subject")),
      p_message: String(f.get("message")),
      p_client_request_id: key.current,
      p_payslip_id: canPay ? (payslipId ?? null) : null,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    key.current = null;
    (e.target as HTMLFormElement).reset();
    router.replace("/pay/queries");
    router.refresh();
  }
  return (
    <form className="card space-y-3" onSubmit={submit}>
      <h2>Ask HR about your pay</h2>
      <p>
        Describe the pay period, expected details and what looks wrong. Avoid
        bank account numbers, tax identifiers and medical information.
      </p>
      {payslipId && (
        <p>
          Related payslip:{" "}
          <Link href={`/payslips/${payslipId}`}>View record</Link>
        </p>
      )}
      <label className="block">
        Topic
        <select className="input" name="category">
          {canPay && (
            <>
              <option value="missing_pay">Missing payment or payslip</option>
              <option value="amount">Incorrect pay amount</option>
              <option value="deductions">Deductions or tax explanation</option>
              <option value="payment_date">Payment date</option>
              <option value="other">Other pay question</option>
            </>
          )}
          {canComp && (
            <option value="compensation">Contractual compensation</option>
          )}
        </select>
      </label>
      <label className="block">
        Subject
        <input
          className="input"
          name="subject"
          required
          minLength={5}
          maxLength={160}
        />
      </label>
      <label className="block">
        Details
        <textarea
          className="input"
          name="message"
          required
          minLength={10}
          maxLength={4000}
          rows={4}
        />
      </label>
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
      <button disabled={busy} className="btn-primary">
        {busy ? "Submitting…" : "Send to HR"}
      </button>
    </form>
  );
}
export function PayQueryThread({
  query: q,
  hr,
}: {
  query: PayQuery;
  hr: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function reply(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      f = new FormData(form);
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("reply_pay_query", {
      p_query_id: q.id,
      p_message: String(f.get("message")),
      p_status: hr ? String(f.get("status")) : "open",
      p_resolution_payslip_id: hr
        ? String(f.get("resolution") ?? "").trim() || null
        : null,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    form.reset();
    router.refresh();
  }
  return (
    <article className="card space-y-3">
      <div>
        <h2>{q.subject}</h2>
        <p>
          {q.category.replace(/_/g, " ")} · {q.status.replace(/_/g, " ")} ·{" "}
          {new Date(q.created_at).toLocaleDateString()}
          {hr ? ` · Employee reference ${q.employee_id}` : ""}
        </p>
      </div>
      {q.payslip_id && (
        <Link href={`/payslips/${q.payslip_id}`}>Related payslip</Link>
      )}
      {q.resolution_payslip_id && (
        <p>
          <Link href={`/payslips/${q.resolution_payslip_id}`}>
            Payslip linked by HR
          </Link>
        </p>
      )}
      <ol className="space-y-3">
        {[...q.pay_query_messages]
          .sort(
            (a, b) =>
              a.created_at.localeCompare(b.created_at) ||
              a.id.localeCompare(b.id),
          )
          .map((m) => (
            <li className="rounded border p-3" key={m.id}>
              <small>
                {m.is_hr ? "HR" : "Employee"} ·{" "}
                {new Date(m.created_at).toLocaleString()}
              </small>
              <p className="whitespace-pre-wrap">{m.body}</p>
            </li>
          ))}
      </ol>
      <form onSubmit={reply} className="space-y-3">
        <label className="block">
          {hr ? "HR response / resolution explanation" : "Follow up or reopen"}
          <textarea
            className="input"
            name="message"
            required
            minLength={10}
            maxLength={4000}
            rows={3}
          />
        </label>
        {hr && (
          <>
            <label className="block">
              Status
              <select
                className="input"
                name="status"
                defaultValue={
                  q.status === "resolved" ? "resolved" : "in_review"
                }
              >
                <option value="open">Open</option>
                <option value="in_review">In review</option>
                <option value="resolved">Resolved</option>
              </select>
            </label>
            <label className="block">
              Resolution payslip reference (optional)
              <input
                className="input"
                name="resolution"
                defaultValue={q.resolution_payslip_id ?? ""}
                pattern="[0-9a-fA-F-]{36}"
              />
              <small>
                Publish any correction first, then paste its record reference.
                An explanation can resolve a query without changing pay.
              </small>
            </label>
          </>
        )}
        {error && (
          <p role="alert" className="alert-error">
            {error}
          </p>
        )}
        <button className="btn-secondary" disabled={busy}>
          {busy ? "Saving…" : hr ? "Save response" : "Send follow-up"}
        </button>
      </form>
    </article>
  );
}
