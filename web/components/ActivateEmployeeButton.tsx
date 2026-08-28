"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";

// Ref: supabase/migrations/20260828140000_employee_activation.sql — most
// employees never need this, since accepting their invite auto-activates
// them. This covers the rest: employees who won't use the portal, or who
// need activating before they accept an invite.
export function ActivateEmployeeButton({ employeeId }: { employeeId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleActivate() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("activate_employee", { p_employee_id: employeeId });

    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not activate this employee."));
      setLoading(false);
      return;
    }

    setLoading(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className="btn-primary px-3 py-1 text-xs" disabled={loading} onClick={() => void handleActivate()}>
        <Icon name="check" size={14} /> {loading ? "Activating…" : "Activate"}
      </button>
      {error && <span className="text-xs leading-snug text-ruby-600">{error}</span>}
    </div>
  );
}
