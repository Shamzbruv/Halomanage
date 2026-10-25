"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
export function RecognitionPreference({
  organizationId,
  allowPublic,
}: {
  organizationId: string;
  allowPublic: boolean;
}) {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function change() {
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("set_recognition_preference", {
      p_organization_id: organizationId,
      p_allow_public: !allowPublic,
    });
    setBusy(false);
    if (error) setError(error.message);
    else router.refresh();
  }
  return (
    <div className="space-y-2">
      <p>
        {allowPublic
          ? "Coworkers may recognize you on the organization feed."
          : "Recognition addressed to you is private to you, the giver and authorized HR moderators."}
      </p>
      <p className="text-sm">
        Switching to private also makes earlier public recognition addressed to
        you private. Re-enabling public recognition does not republish earlier
        messages.
      </p>
      <button className="btn-secondary" disabled={busy} onClick={change}>
        {busy
          ? "Saving…"
          : allowPublic
            ? "Keep my recognition private"
            : "Allow future public recognition"}
      </button>
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
    </div>
  );
}
export function RecognitionActions({
  id,
  canMakePrivate,
  moderator = false,
  points = 0,
}: {
  id: string;
  canMakePrivate: boolean;
  moderator?: boolean;
  points?: number;
}) {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function privateAudience() {
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("make_recognition_private", {
      p_recognition_id: id,
    });
    setBusy(false);
    if (error) setError(error.message);
    else router.refresh();
  }
  async function send(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      form = e.currentTarget,
      action = String(f.get("action") ?? "report");
    if (
      action === "remove" &&
      !confirm(
        `Remove this recognition and reverse ${points} points? If points were already spent, the recipient's Rewards balance may become negative and pending redemptions need HR review.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc(
      moderator ? "moderate_recognition" : "report_recognition",
      moderator
        ? {
            p_recognition_id: id,
            p_action: action,
            p_reason: String(f.get("reason")),
          }
        : { p_recognition_id: id, p_reason: String(f.get("reason")) },
    );
    setBusy(false);
    if (error) setError(error.message);
    else {
      form.reset();
      router.refresh();
    }
  }
  return (
    <div className="mt-3 space-y-2">
      {canMakePrivate && (
        <button
          disabled={busy}
          className="btn-secondary"
          onClick={privateAudience}
        >
          Make private
        </button>
      )}
      <details>
        <summary>
          {moderator ? "HR review" : "Report a concern or request a correction"}
        </summary>
        <form onSubmit={send} className="mt-2 space-y-2">
          <label className="block">
            {moderator ? "Decision explanation" : "Explain the concern"}
            <textarea
              className="input"
              name="reason"
              required
              minLength={10}
              maxLength={2000}
              rows={3}
            />
          </label>
          {moderator && (
            <label className="block">
              Action
              <select className="input" name="action">
                <option value="dismiss">
                  Close reports; retain recognition
                </option>
                <option value="remove">
                  Remove recognition and reverse attached points
                </option>
              </select>
            </label>
          )}
          <p className="text-xs">
            {moderator
              ? "Removal is permanent. Giving allowance remains used. Review any pending redemptions in Rewards."
              : "Your report is visible to you and authorized HR moderators. Do not include unrelated sensitive information."}
          </p>
          <button className="btn-secondary" disabled={busy}>
            {busy
              ? "Saving…"
              : moderator
                ? "Record HR decision"
                : "Send report to HR"}
          </button>
        </form>
      </details>
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
    </div>
  );
}
