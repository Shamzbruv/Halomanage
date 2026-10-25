"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { RecognitionState } from "@/lib/recognition";
export type CoworkerOption = {
  id: string;
  label: string;
  employee_number: string;
  allow_public: boolean;
};
export type RecognitionValueOption = {
  id: string;
  name: string;
  description?: string | null;
};
export function GiveRecognitionForm({
  organizationId,
  initialCoworkers,
  values,
  state,
}: {
  organizationId: string;
  initialCoworkers: CoworkerOption[];
  values: RecognitionValueOption[];
  state: RecognitionState;
}) {
  const router = useRouter(),
    dialog = useRef<HTMLDialogElement>(null),
    retry = useRef<{ payload: string; key: string } | null>(null);
  const [coworkers, setCoworkers] = useState(initialCoworkers),
    [search, setSearch] = useState(""),
    [recipientId, setRecipientId] = useState(""),
    [valueId, setValueId] = useState(""),
    [message, setMessage] = useState(""),
    [points, setPoints] = useState("0"),
    [visibility, setVisibility] = useState(state.settings.default_visibility),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const pointsEnabled =
      state.rewards_enabled && state.settings.monthly_point_allowance > 0,
    cap = Math.min(
      state.remaining_points,
      state.settings.max_points_per_recognition ?? state.remaining_points,
      state.settings.max_points_per_recipient_per_month ??
        state.remaining_points,
    ),
    recipient = coworkers.find((c) => c.id === recipientId);
  async function find() {
    setBusy(true);
    setError(null);
    const { data, error } = await createClient().rpc(
      "search_recognition_coworkers",
      { p_organization_id: organizationId, p_search: search },
    );
    setBusy(false);
    if (error) setError(error.message);
    else {
      setCoworkers(data ?? []);
      setRecipientId("");
    }
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const args = {
      p_organization_id: organizationId,
      p_recipient_employee_id: recipientId,
      p_message: message.trim(),
      p_recognition_value_id: valueId || null,
      p_points: pointsEnabled ? Number(points) : 0,
      p_visibility: visibility,
    };
    const payload = JSON.stringify(args);
    if (retry.current?.payload !== payload)
      retry.current = { payload, key: crypto.randomUUID() };
    const { error } = await createClient().rpc("send_recognition", {
      ...args,
      p_client_request_id: retry.current.key,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    retry.current = null;
    setMessage("");
    setPoints("0");
    setRecipientId("");
    dialog.current?.close();
    router.refresh();
  }
  if (!state.can_give)
    return (
      <p>Your role can read recognition. Giving recognition is unavailable.</p>
    );
  if (!state.settings.enabled)
    return (
      <p>HR has paused new recognition. Your history remains available.</p>
    );
  if (!state.daily_remaining)
    return (
      <p>
        Your daily limit is reached. You can give recognition again after the
        organization’s next local midnight.
      </p>
    );
  return (
    <>
      <button
        className="btn-primary"
        onClick={() => dialog.current?.showModal()}
      >
        Recognize a coworker
      </button>
      <dialog
        ref={dialog}
        className="recognition-dialog"
        aria-labelledby="give-recognition-title"
        onCancel={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 id="give-recognition-title">Recognize a coworker</h2>
            <button
              type="button"
              disabled={busy}
              aria-label="Close recognition form"
              onClick={() => dialog.current?.close()}
            >
              Close
            </button>
          </div>
          <p>
            Describe the action and why it mattered. Keep personal, medical,
            customer and pay information out of your message.
          </p>
          <label className="block">
            Find a coworker
            <input
              className="input"
              value={search}
              maxLength={100}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name or employee number"
            />
          </label>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={find}
          >
            Search coworkers
          </button>
          <label className="block">
            Coworker
            <select
              required
              className="input"
              value={recipientId}
              onChange={(e) => setRecipientId(e.target.value)}
            >
              <option value="">Choose a coworker</option>
              {coworkers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} · {c.employee_number}
                </option>
              ))}
            </select>
          </label>
          {!coworkers.length && (
            <p>
              No eligible coworkers match. Try another search or contact HR.
            </p>
          )}
          <label className="block">
            Organization value
            <select
              className="input"
              required={state.settings.require_value}
              value={valueId}
              onChange={(e) => setValueId(e.target.value)}
            >
              <option value="">
                {state.settings.require_value
                  ? "Choose a value"
                  : "General appreciation (optional value)"}
              </option>
              {values.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          {valueId && (
            <p className="text-sm">
              {values.find((v) => v.id === valueId)?.description}
            </p>
          )}
          <label className="block">
            Message
            <textarea
              className="input"
              required
              maxLength={500}
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Thank you for helping the team resolve… It made a difference because…"
            />
          </label>
          <small>{message.length}/500 characters</small>
          {pointsEnabled && (
            <label className="block">
              Points (optional)
              <input
                className="input"
                type="number"
                min={0}
                max={cap}
                step={1}
                required
                value={points}
                onChange={(e) => setPoints(e.target.value)}
              />
              <small>
                {state.remaining_points.toLocaleString()} points left to give
                this month. Giving does not spend your own Rewards balance.
              </small>
            </label>
          )}
          <label className="block">
            Audience
            <select
              className="input"
              value={visibility}
              onChange={(e) =>
                setVisibility(e.target.value as "public" | "private")
              }
            >
              <option value="public">Organization feed</option>
              <option value="private">
                Giver, recipient and authorized HR moderators
              </option>
            </select>
          </label>
          {recipient?.allow_public === false && (
            <p>
              This coworker prefers private recognition. Your message will be
              private even if you choose the organization feed.
            </p>
          )}
          {error && (
            <p role="alert" className="alert-error">
              {error}
            </p>
          )}
          <button disabled={busy || !recipientId} className="btn-primary">
            {busy ? "Sending…" : "Send recognition"}
          </button>
        </form>
      </dialog>
    </>
  );
}
