"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function OrgUnitForm({
  organizationId,
  parentOptions,
}: {
  organizationId: string;
  parentOptions: { id: string; name: string }[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [name, setName] = useState("");
  const [type, setType] = useState("department");
  const [parentId, setParentId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.from("org_units").insert({
      organization_id: organizationId,
      name,
      type,
      parent_id: parentId || null,
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setName("");
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <input required placeholder="Name (e.g. Customer Service)" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="grid grid-cols-2 gap-2">
        <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="company">Company</option>
          <option value="division">Division</option>
          <option value="department">Department</option>
          <option value="team">Team</option>
          <option value="other">Other</option>
        </select>
        <select className="input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">No parent</option>
          {parentOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={loading} className="btn-secondary w-full">
        {loading ? "Adding…" : "Add unit"}
      </button>
    </form>
  );
}
