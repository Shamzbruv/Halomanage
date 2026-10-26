"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { RewardDialog as WorkflowDialog } from "./rewards/RewardDialog";
export function LaunchCycleButton({ cycleId }: { cycleId: string }) {
  const router = useRouter(),
    lock = useRef(false);
  const [open, setOpen] = useState(false),
    [rows, setRows] = useState<
      { employee_id: string; employee_name: string; warning: string | null }[]
    >([]),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function preview() {
    setOpen(true);
    setBusy(true);
    setError(null);
    setLoaded(false);
    try {
      const { data, error } = await createClient().rpc(
        "preview_performance_roster",
        { p_cycle_id: cycleId },
      );
      if (error) throw error;
      setRows(data ?? []);
      setLoaded(true);
    } catch (e) {
      setError(
        (e as { message?: string }).message ?? "Unable to preview roster.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function launch() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const { error } = await createClient().rpc("launch_appraisal_cycle", {
        p_cycle_id: cycleId,
      });
      if (error) throw error;
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(
        (e as { message?: string }).message ?? "Unable to launch cycle.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="btn-primary"
        disabled={busy}
        onClick={() => void preview()}
      >
        Preview roster and launch
      </button>
      <WorkflowDialog
        open={open}
        onClose={() => setOpen(false)}
        busy={busy}
        title="Review the cycle roster"
      >
        <div className="space-y-3">
          <p>
            {loaded
              ? `${rows.length} eligible employee accounts match.`
              : "Loading roster…"}
          </p>
          <p>
            The roster is checked again at launch. Missing independent leaders
            require HR assignment; no employee can approve their own review.
          </p>
          <ul className="max-h-72 overflow-y-auto">
            {rows.map((r) => (
              <li key={r.employee_id} className="border-b py-2">
                {r.employee_name}
                {r.warning && <p className="text-sm">{r.warning}</p>}
              </li>
            ))}
          </ul>
          {error && (
            <p role="alert" className="alert-error">
              {error}
            </p>
          )}
          <button
            className="btn-primary"
            disabled={busy || !loaded || !rows.length}
            onClick={() => void launch()}
          >
            {busy ? "Working…" : `Launch for current matching roster`}
          </button>
        </div>
      </WorkflowDialog>
    </>
  );
}
