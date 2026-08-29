"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export type RecognitionSettings = {
  monthly_point_allowance: number;
  max_points_per_recognition: number | null;
  max_recognitions_per_day_per_giver: number | null;
  default_visibility: "public" | "private";
};

export function RecognitionSettingsForm({ organizationId, initial }: { organizationId: string; initial: RecognitionSettings }) {
  const supabase = createClient();
  const router = useRouter();
  const [allowance, setAllowance] = useState(String(initial.monthly_point_allowance));
  const [maxPerRecognition, setMaxPerRecognition] = useState(initial.max_points_per_recognition !== null ? String(initial.max_points_per_recognition) : "");
  const [maxPerDay, setMaxPerDay] = useState(initial.max_recognitions_per_day_per_giver !== null ? String(initial.max_recognitions_per_day_per_giver) : "");
  const [defaultVisibility, setDefaultVisibility] = useState(initial.default_visibility);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: updateError } = await supabase
      .from("organization_recognition_settings")
      .update({
        monthly_point_allowance: Number(allowance),
        max_points_per_recognition: maxPerRecognition ? Number(maxPerRecognition) : null,
        max_recognitions_per_day_per_giver: maxPerDay ? Number(maxPerDay) : null,
        default_visibility: defaultVisibility,
      })
      .eq("organization_id", organizationId);
    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }
    setLoading(false);
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3">
      <div>
        <label className="label" htmlFor="rec-allowance">Monthly giving allowance <span className="font-normal text-stone-500">(0 = kudos-only)</span></label>
        <input id="rec-allowance" type="number" min="0" className="input" value={allowance} onChange={(e) => { setAllowance(e.target.value); setSaved(false); }} />
      </div>
      <div>
        <label className="label" htmlFor="rec-max-single">Max points per recognition <span className="font-normal text-stone-500">(optional)</span></label>
        <input id="rec-max-single" type="number" min="1" placeholder="No limit" className="input" value={maxPerRecognition} onChange={(e) => { setMaxPerRecognition(e.target.value); setSaved(false); }} />
      </div>
      <div>
        <label className="label" htmlFor="rec-max-day">Max recognitions per person per day <span className="font-normal text-stone-500">(optional)</span></label>
        <input id="rec-max-day" type="number" min="1" placeholder="No limit" className="input" value={maxPerDay} onChange={(e) => { setMaxPerDay(e.target.value); setSaved(false); }} />
      </div>
      <div>
        <label className="label" htmlFor="rec-visibility">Default visibility</label>
        <select id="rec-visibility" className="input" value={defaultVisibility} onChange={(e) => { setDefaultVisibility(e.target.value as "public" | "private"); setSaved(false); }}>
          <option value="public">Public</option>
          <option value="private">Private</option>
        </select>
      </div>
      {error && <p className="alert-error col-span-2">{error}</p>}
      {saved && !error && <p className="col-span-2 text-xs text-emerald-700">Recognition settings updated.</p>}
      <div className="col-span-2"><button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Save recognition settings"}</button></div>
    </form>
  );
}
