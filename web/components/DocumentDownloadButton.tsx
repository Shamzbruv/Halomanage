"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function DocumentDownloadButton({ bucket, path }: { bucket: string; path: string }) {
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60);
    setLoading(false);
    if (error || !data) {
      setError(error?.message ?? "Could not generate a link");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <span className="flex items-center gap-2">
      <button className="btn-secondary px-3 py-1 text-xs" disabled={loading} onClick={handleClick}>
        {loading ? "…" : "Download"}
      </button>
      {error && <span className="text-xs text-error">{error}</span>}
    </span>
  );
}
