"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatTime } from "@/lib/timezone";

// Clock and break actions — only ever the clock_in()/clock_out()/
// start_break()/end_break() RPCs. The server sets every timestamp (now())
// and stamps the source; nothing here sends a time or claims to be a kiosk.
// Times are shown in the organization's timezone, like everywhere else.
export function ClockButton({
  openSession,
  timezone,
  onBreak = false,
  showBreaks = false,
}: {
  openSession: { clock_in_at: string } | null;
  timezone: string | undefined;
  onBreak?: boolean;
  showBreaks?: boolean;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: "clock_in" | "clock_out" | "start_break" | "end_break") {
    setLoading(action);
    setError(null);
    const { error: rpcError } = await supabase.rpc(action, {});
    if (rpcError) {
      setError(rpcError.message);
      setLoading(null);
      return;
    }
    router.refresh();
    setLoading(null);
  }

  return (
    <div className="space-y-2">
      {!openSession && (
        <button onClick={() => run("clock_in")} disabled={loading !== null} className="btn-primary w-full">{loading ? "Working…" : "Clock In"}</button>
      )}
      {openSession && showBreaks && (
        onBreak
          ? <button onClick={() => run("end_break")} disabled={loading !== null} className="btn-primary w-full">{loading === "end_break" ? "Working…" : "End break"}</button>
          : <button onClick={() => run("start_break")} disabled={loading !== null} className="btn-secondary w-full">{loading === "start_break" ? "Working…" : "Start break"}</button>
      )}
      {openSession && (
        <button onClick={() => run("clock_out")} disabled={loading !== null} className="btn-danger w-full">{loading === "clock_out" ? "Working…" : "Clock Out"}</button>
      )}
      {openSession && (
        <p className="text-center text-xs text-stone-500">Clocked in at {formatTime(openSession.clock_in_at, timezone)}{onBreak ? " · on a break" : ""}</p>
      )}
      {error && <p className="text-center text-xs text-error" role="alert">{error}</p>}
    </div>
  );
}

export function WithdrawCorrectionButton({ adjustmentId }: { adjustmentId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-end gap-1">
      <button type="button" className="table-action" disabled={loading} onClick={async () => {
        setLoading(true);
        setError(null);
        const { error: rpcError } = await supabase.rpc("cancel_attendance_adjustment", { p_adjustment_id: adjustmentId });
        if (rpcError) setError(rpcError.message);
        setLoading(false);
        router.refresh();
      }}>{loading ? "Withdrawing…" : "Withdraw"}</button>
      {error && <span className="text-xs text-ruby-600">{error}</span>}
    </span>
  );
}
