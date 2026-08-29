"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";
import { Icon } from "@/components/Icon";

export type CoworkerOption = { id: string; label: string };
export type RecognitionValueOption = { id: string; name: string };

// Ref: supabase/migrations/20260830140000_peer_recognition.sql —
// give_recognition() draws points from a separate monthly giving
// allowance, never from the giver's own redeemable balance. Points are
// always optional; a company running kudos-only recognition simply has
// its allowance set to 0, and this form still works, just without the
// points field doing anything.
export function GiveRecognitionForm({
  coworkers,
  values,
  monthlyAllowance,
  remainingAllowance,
  maxPointsPerRecognition,
  defaultVisibility,
}: {
  coworkers: CoworkerOption[];
  values: RecognitionValueOption[];
  monthlyAllowance: number;
  remainingAllowance: number;
  maxPointsPerRecognition: number | null;
  defaultVisibility: "public" | "private";
}) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [recipientId, setRecipientId] = useState(coworkers[0]?.id ?? "");
  const [valueId, setValueId] = useState(values[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [points, setPoints] = useState("0");
  const [visibility, setVisibility] = useState<"public" | "private">(defaultVisibility);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pointsEnabled = monthlyAllowance > 0;
  const pointsCap = maxPointsPerRecognition !== null ? Math.min(maxPointsPerRecognition, remainingAllowance) : remainingAllowance;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("give_recognition", {
      p_recipient_employee_id: recipientId,
      p_message: message,
      p_recognition_value_id: valueId || null,
      p_points: pointsEnabled ? Number(points) : 0,
      p_visibility: visibility,
    });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not give this recognition."));
      setLoading(false);
      return;
    }
    setOpen(false);
    setLoading(false);
    setMessage("");
    setPoints("0");
    router.refresh();
  }

  if (coworkers.length === 0) {
    return <p className="text-sm text-stone-400">There&apos;s no one else in your organization to recognize yet.</p>;
  }

  if (!open) {
    return <button type="button" className="btn-primary" onClick={() => setOpen(true)}><Icon name="spark" size={16} /> Recognize a coworker</button>;
  }

  return (
    <div className="modal-layer" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="Close dialog" onClick={() => setOpen(false)} />
      <form onSubmit={handleSubmit} className="modal-card space-y-3" role="dialog" aria-modal="true" aria-labelledby="give-recognition-title">
        <div className="modal-head"><div><span className="eyebrow">Recognition</span><h3 id="give-recognition-title">Recognize a coworker</h3></div><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setOpen(false)}><Icon name="x" size={18} /></button></div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="recognition-recipient">Coworker</label>
            <select id="recognition-recipient" className="input" value={recipientId} onChange={(e) => setRecipientId(e.target.value)}>
              {coworkers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="recognition-value">Value</label>
            <select id="recognition-value" className="input" value={valueId} onChange={(e) => setValueId(e.target.value)}>
              {values.length === 0 && <option value="">Not specified</option>}
              {values.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <div className="col-span-2"><label className="label" htmlFor="recognition-message">Message</label><textarea id="recognition-message" required maxLength={500} rows={3} className="input" placeholder="What did they do?" value={message} onChange={(e) => setMessage(e.target.value)} /></div>
          <div>
            <label className="label" htmlFor="recognition-points">
              Points {pointsEnabled ? <span className="font-normal text-stone-500">({remainingAllowance.toLocaleString()} left this month)</span> : <span className="font-normal text-stone-500">(not enabled)</span>}
            </label>
            <input id="recognition-points" type="number" min="0" max={pointsCap} disabled={!pointsEnabled} className="input" value={points} onChange={(e) => setPoints(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="recognition-visibility">Visibility</label>
            <select id="recognition-visibility" className="input" value={visibility} onChange={(e) => setVisibility(e.target.value as "public" | "private")}>
              <option value="public">Public — visible to your organization</option>
              <option value="private">Private — just for {coworkers.find((c) => c.id === recipientId)?.label ?? "them"}</option>
            </select>
          </div>
        </div>
        {error && <p className="alert-error">{error}</p>}
        <div className="flex gap-2"><button type="submit" disabled={loading} className="btn-primary">{loading ? "Sending…" : "Send recognition"}</button><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </div>
  );
}
