"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";
import { Icon } from "@/components/Icon";

// Ref: delete_onboarding_template() in 20260904100000_delete_onboarding_template.sql.
// The database itself blocks deleting a template that has ever actually
// onboarded someone (onboarding_runs restricts its referenced template
// version) — this button's own copy just explains that in advance rather
// than everyone finding out from an error after clicking.
export function DeleteOnboardingTemplateButton({ templateId, templateName }: { templateId: string; templateName: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("delete_onboarding_template", { p_template_id: templateId });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not delete this template."));
      setLoading(false);
      return;
    }
    router.push("/admin/onboarding");
    router.refresh();
  }

  return (
    <>
      <button type="button" className="btn-danger px-3 py-1 text-xs" onClick={() => setOpen(true)}>
        <Icon name="trash" size={14} /> Delete template
      </button>

      {open && (
        <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby="delete-template-title">
          <button type="button" className="modal-backdrop" aria-label="Cancel" onClick={() => !loading && setOpen(false)} />
          <div className="modal-card">
            <h2 id="delete-template-title" className="text-base font-semibold text-stone-900">Delete {templateName}?</h2>
            <p className="mt-1 text-xs leading-5 text-stone-500">
              This removes the template and its steps. Only possible if it has never been used to onboard anyone — if it
              has, use the setup guide to build a new version instead. This cannot be undone.
            </p>
            {error && <p className="alert-error mt-3" role="alert">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn-secondary" disabled={loading} onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn-danger" disabled={loading} onClick={() => void handleConfirm()}>
                {loading ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
