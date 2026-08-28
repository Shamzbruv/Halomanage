"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";

export function EmployeeImportActions({ batchId, status }: { batchId: string; status: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function commit() {
    if (!confirm("Import every validated employee row now? This action is recorded in the audit trail.")) return;
    setLoading("commit");
    setError(null);
    const { error: commitError } = await createClient().rpc("commit_employee_import_batch", { p_batch_id: batchId });
    if (commitError) setError(commitError.message);
    else router.refresh();
    setLoading(null);
  }

  async function rollback() {
    if (!confirm("Roll back this import? Halomanage will stop if any imported employee has activity or later changes.")) return;
    setLoading("rollback");
    setError(null);
    const { error: rollbackError } = await createClient().rpc("rollback_employee_import_batch", { p_batch_id: batchId });
    if (rollbackError) setError(rollbackError.message);
    else router.refresh();
    setLoading(null);
  }

  async function retry() {
    setLoading("retry");
    setError(null);
    const { error: retryError } = await createClient().functions.invoke("employee-import", { body: { batch_id: batchId } });
    if (retryError) setError(await resolveFunctionErrorMessage(retryError));
    else router.refresh();
    setLoading(null);
  }

  return (
    <div className="migration-action-bar">
      <div><span className="eyebrow">Posting control</span><strong>{status === "ready_for_import" ? "The dry-run is clean and ready." : status === "committed" ? "This batch has been imported." : status === "rolled_back" ? "This batch was safely rolled back." : "Review the batch before posting."}</strong></div>
      <div>
        {status === "ready_for_import" && <button className="btn-primary" type="button" disabled={!!loading} onClick={commit}>{loading === "commit" ? "Importing…" : <>Commit employee import <Icon name="arrow-right" size={16} /></>}</button>}
        {status === "committed" && <button className="btn-secondary" type="button" disabled={!!loading} onClick={rollback}>{loading === "rollback" ? "Checking rollback…" : "Safe rollback"}</button>}
        {["failed", "needs_review", "needs_mapping"].includes(status) && <button className="btn-secondary" type="button" disabled={!!loading} onClick={retry}>{loading === "retry" ? "Reprocessing…" : "Process again"}</button>}
      </div>
      {error && <p className="alert-error" role="alert">{error}</p>}
    </div>
  );
}
