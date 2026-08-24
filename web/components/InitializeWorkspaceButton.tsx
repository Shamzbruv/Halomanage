"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";

export function InitializeWorkspaceButton({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function initialize() {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error: initializeError } = await supabase.rpc("initialize_organization_workspace", {
      p_organization_id: organizationId,
    });
    if (initializeError) {
      setError(initializeError.message);
      setLoading(false);
      return;
    }
    router.refresh();
  }

  return (
    <div>
      <button className="btn-primary" disabled={loading} type="button" onClick={initialize}>{loading ? "Adding starter setup…" : <>Add recommended starter setup <Icon name="spark" size={16} /></>}</button>
      {error && <p className="alert-error mt-3" role="alert">{error}</p>}
    </div>
  );
}
