import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { recognitionPage } from "@/lib/recognition";
import { formatDate } from "@/lib/timezone";
export const dynamic = "force-dynamic";
export default async function Reports({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const s = await getCurrentSession();
  if (!s) redirect("/login");
  if (!s.organizationId) redirect("/dashboard");
  const p = await searchParams,
    page = recognitionPage(p.page),
    { data, error } = await (
      await createClient()
    ).rpc("list_recognition_reports", {
      p_organization_id: s.organizationId,
      p_status: "all",
      p_page: page,
      p_self: true,
    });
  const reports = data as {
    total: number;
    items: {
      id: string;
      reason: string;
      status: string;
      resolution: string | null;
      created_at: string;
    }[];
  } | null;
  return (
    <div className="recognition-workspace space-y-6">
      <div className="page-intro">
        <Link href="/recognition">← Recognition</Link>
        <h1>My reports to HR</h1>
      </div>
      {error && (
        <p role="alert" className="alert-error">
          Reports could not be loaded. {error.message}
        </p>
      )}
      {reports?.items.map((r) => (
        <article className="card" key={r.id}>
          <h2>
            {r.status === "open" ? "Awaiting HR review" : "Reviewed by HR"}
          </h2>
          <p className="whitespace-pre-wrap">{r.reason}</p>
          {r.resolution && <p>HR response: {r.resolution}</p>}
          <small>{formatDate(r.created_at, s.organization?.timezone)}</small>
        </article>
      ))}
      {!error && !reports?.items.length && <p>No reports submitted.</p>}
      <nav className="flex gap-4">
        {page > 1 && (
          <Link href={`/recognition/reports?page=${page - 1}`}>
            Previous page
          </Link>
        )}
        {reports && page * 20 < reports.total && (
          <Link href={`/recognition/reports?page=${page + 1}`}>Next page</Link>
        )}
      </nav>
    </div>
  );
}
