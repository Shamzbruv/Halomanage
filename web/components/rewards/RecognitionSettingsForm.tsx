"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { RecognitionSettings as Settings } from "@/lib/recognition";
export type RecognitionSettings = Settings;
export function RecognitionSettingsForm({
  organizationId,
  initial,
}: {
  organizationId: string;
  initial: Settings;
}) {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [saved, setSaved] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const f = new FormData(e.currentTarget),
      optional = (name: string) =>
        String(f.get(name) ?? "").trim() ? Number(f.get(name)) : null;
    const { error } = await createClient().rpc("save_recognition_settings", {
      p_organization_id: organizationId,
      p_settings: {
        monthly_point_allowance: Number(f.get("allowance")),
        max_points_per_recognition: optional("single"),
        max_recognitions_per_day_per_giver: optional("daily"),
        max_points_per_recipient_per_month: optional("recipient"),
        default_visibility: String(f.get("visibility")),
        enabled: f.has("enabled"),
        require_value: f.has("require_value"),
      },
    });
    setBusy(false);
    if (error) setError(error.message);
    else {
      setSaved(true);
      router.refresh();
    }
  }
  return (
    <form
      className="grid gap-4 md:grid-cols-2"
      onSubmit={submit}
      onChange={() => setSaved(false)}
    >
      <label>
        Monthly giving allowance (0 = kudos only)
        <input
          className="input"
          name="allowance"
          type="number"
          min={0}
          max={1000000}
          step={1}
          defaultValue={initial.monthly_point_allowance}
          required
        />
      </label>
      <label>
        Maximum points per recognition
        <input
          className="input"
          name="single"
          type="number"
          min={1}
          max={1000000}
          step={1}
          defaultValue={initial.max_points_per_recognition ?? ""}
          placeholder="Monthly allowance applies"
        />
      </label>
      <label>
        Recognition posts per giver per day
        <input
          className="input"
          name="daily"
          type="number"
          min={1}
          max={100}
          step={1}
          defaultValue={initial.max_recognitions_per_day_per_giver ?? ""}
          placeholder="100 (system limit)"
        />
      </label>
      <label>
        Points from one giver to one recipient per month
        <input
          className="input"
          name="recipient"
          type="number"
          min={1}
          max={1000000}
          step={1}
          defaultValue={initial.max_points_per_recipient_per_month ?? ""}
          placeholder="No additional limit"
        />
      </label>
      <label>
        Default audience
        <select
          className="input"
          name="visibility"
          defaultValue={initial.default_visibility}
        >
          <option value="public">Organization feed</option>
          <option value="private">Giver, recipient and HR moderators</option>
        </select>
      </label>
      <div className="space-y-3">
        <label className="block">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={initial.enabled}
          />{" "}
          Allow new recognition
        </label>
        <label className="block">
          <input
            type="checkbox"
            name="require_value"
            defaultChecked={initial.require_value}
          />{" "}
          Require an organization value
        </label>
      </div>
      <p className="md:col-span-2">
        Limits reset by the organization’s local calendar. Changes apply to new
        posts; existing history and consumed allowance are retained. Recognition
        can run without Rewards; attaching points requires Rewards to be
        enabled.
      </p>
      {error && (
        <p className="alert-error md:col-span-2" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="md:col-span-2">
          Recognition policy saved.
        </p>
      )}
      <div>
        <button className="btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save recognition policy"}
        </button>
      </div>
    </form>
  );
}
