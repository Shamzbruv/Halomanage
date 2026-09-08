"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function AssignTrainingForm({
  organizationId,
  employeeId,
  courses,
}: {
  organizationId: string;
  employeeId: string;
  courses: { id: string; name: string; validity_months: number | null }[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [courseId, setCourseId] = useState(courses[0]?.id ?? "");
  const [expiresOn, setExpiresOn] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.from("employee_training").insert({
      organization_id: organizationId,
      employee_id: employeeId,
      course_id: courseId,
      status: "assigned",
      expires_on: expiresOn || null,
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setExpiresOn("");
    setLoading(false);
    router.refresh();
  }

  if (courses.length === 0) return <p className="text-xs text-stone-400">No active courses in the catalog yet — add one from Learning &amp; assets.</p>;

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      <div>
        <label className="label">Course</label>
        <select className="input" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
          {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div>
        <label className="label">Expires on (optional)</label>
        <input type="date" className="input" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
      </div>
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={loading || !courseId} className="btn-secondary">{loading ? "…" : "Assign"}</button>
    </form>
  );
}
