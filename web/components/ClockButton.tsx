"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { AttendanceSession } from "@/lib/supabase/types";

// Ref: ARCHITECTURE.md "Attendance sign-in and sign-out" — this button only
// ever calls the clock_in()/clock_out() RPCs. There is no code path here
// that writes a timestamp the client chose; the server sets now() and this
// component just reflects whatever comes back.
export function ClockButton({ openSession }: { openSession: AttendanceSession | null }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);

    const { error } = openSession
      ? await supabase.rpc("clock_out", {})
      : await supabase.rpc("clock_in", {});

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.refresh();
    setLoading(false);
  }

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={loading}
        className={openSession ? "btn-danger w-full" : "btn-primary w-full"}
      >
        {loading ? "Working…" : openSession ? "Clock Out" : "Clock In"}
      </button>
      {openSession && (
        <p className="mt-2 text-center text-xs text-stone-500">
          Clocked in at {new Date(openSession.clock_in_at).toLocaleTimeString()}
        </p>
      )}
      {error && <p className="mt-2 text-center text-xs text-error">{error}</p>}
    </div>
  );
}
