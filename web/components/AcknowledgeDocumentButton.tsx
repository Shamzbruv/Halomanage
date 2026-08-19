"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function AcknowledgeDocumentButton({ documentVersionId }: { documentVersionId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    const { error } = await supabase.rpc("acknowledge_document", { p_document_version_id: documentVersionId });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    router.refresh();
  }

  return (
    <span className="flex items-center gap-2">
      <button className="btn-primary px-3 py-1 text-xs" disabled={loading} onClick={handleClick}>
        {loading ? "…" : "Acknowledge"}
      </button>
      {error && <span className="text-xs text-error">{error}</span>}
    </span>
  );
}
