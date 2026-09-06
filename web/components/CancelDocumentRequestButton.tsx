"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function CancelDocumentRequestButton({ requestId }: { requestId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    const { error } = await supabase.rpc("cancel_document_request", { p_request_id: requestId });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    router.refresh();
  }

  return (
    <span className="flex items-center gap-2">
      <button type="button" className="table-action" disabled={loading} onClick={handleClick}>{loading ? "…" : "Cancel request"}</button>
      {error && <span className="text-xs text-error">{error}</span>}
    </span>
  );
}
