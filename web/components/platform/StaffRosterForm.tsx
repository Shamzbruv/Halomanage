"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";
import type { PlatformRole } from "@/lib/platform-session";

const ROLES: PlatformRole[] = ["owner", "admin", "support", "billing", "developer", "security"];

export type StaffRow = { user_id: string; role: PlatformRole; display_name: string | null; created_at: string };

export function StaffRosterForm({ staff, selfUserId, canManage }: { staff: StaffRow[]; selfUserId: string; canManage: boolean }) {
  const supabase = createClient();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<PlatformRole>("support");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("platform_add_staff", { p_email: email.trim(), p_role: role });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not add this person."));
      setLoading(false);
      return;
    }
    setEmail("");
    setLoading(false);
    router.refresh();
  }

  async function handleRemove(userId: string) {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("platform_remove_staff", { p_user_id: userId });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not remove this person."));
      setLoading(false);
      return;
    }
    setLoading(false);
    router.refresh();
  }

  return (
    <div>
      {error && <p className="platform-alert-error" style={{ marginBottom: "0.75rem" }}>{error}</p>}

      <div style={{ overflowX: "auto", marginBottom: canManage ? "1.25rem" : 0 }}>
        <table className="platform-table">
          <thead><tr><th>Name</th><th>Role</th><th>Added</th>{canManage && <th></th>}</tr></thead>
          <tbody>
            {staff.map((member) => (
              <tr key={member.user_id}>
                <td>{member.display_name ?? member.user_id}</td>
                <td><span className="platform-badge accent">{member.role}</span></td>
                <td style={{ color: "var(--p-text-muted)" }}>{new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(member.created_at))}</td>
                {canManage && (
                  <td>
                    {member.user_id !== selfUserId && (
                      <button type="button" disabled={loading} className="platform-btn platform-btn-danger" onClick={() => void handleRemove(member.user_id)}>
                        Remove
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && (
        <form onSubmit={handleAdd} style={{ display: "flex", gap: "0.6rem", alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 220px" }}>
            <label className="platform-label" htmlFor="staff-email">Add by email</label>
            <input id="staff-email" type="email" required className="platform-input" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="teammate@halomanage.com" />
          </div>
          <div>
            <label className="platform-label" htmlFor="staff-role">Role</label>
            <select id="staff-role" className="platform-select" value={role} onChange={(event) => setRole(event.target.value as PlatformRole)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <button type="submit" disabled={loading} className="platform-btn platform-btn-primary">
            {loading ? "Adding…" : "Add"}
          </button>
        </form>
      )}
    </div>
  );
}
