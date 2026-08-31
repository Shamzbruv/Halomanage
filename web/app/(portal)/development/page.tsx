import Link from "next/link";
import { redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { statusBadgeClass } from "@/lib/ui";

export default async function DevelopmentPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");
  const supabase = await createClient();
  const employeeId = session.employee.id;
  const [{ data: training }, { data: certifications }, { data: assetAssignments }] = await Promise.all([
    supabase.from("employee_training").select("*, training_courses(name, description, is_required)").eq("employee_id", employeeId).order("created_at", { ascending: false }),
    supabase.from("certifications").select("*").eq("employee_id", employeeId).order("expires_on", { ascending: true }),
    supabase.from("employee_asset_assignments").select("*, assets(name, category, serial_number)").eq("employee_id", employeeId).is("returned_at", null).order("assigned_at", { ascending: false }),
  ]);
  const openTraining = (training ?? []).filter((item) => item.status !== "completed").length;
  const certificationsWithExpiry = (certifications ?? []).filter((item) => item.expires_on).length;

  return (
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">Learning & resources</span><h1>Everything assigned to help you do your best work.</h1><p>Track required learning, professional certifications, and company equipment without chasing separate spreadsheets.</p></div>
      <div className="dashboard-metrics">
        <div className="metric-card"><span className="metric-icon mint"><Icon name="spark" /></span><div><small>Open learning</small><strong>{openTraining}</strong><em>courses to complete</em></div></div>
        <div className="metric-card"><span className="metric-icon sun"><Icon name="document" /></span><div><small>Certifications</small><strong>{(certifications ?? []).length}</strong><em>{certificationsWithExpiry ? `${certificationsWithExpiry} with renewal dates` : "on your record"}</em></div></div>
        <div className="metric-card"><span className="metric-icon coral"><Icon name="organization" /></span><div><small>Assigned assets</small><strong>{(assetAssignments ?? []).length}</strong><em>currently with you</em></div></div>
      </div>
      <div className="development-grid">
        <section className="card"><div className="panel-heading"><div><span className="panel-icon"><Icon name="spark" /></span><div><h3>Learning plan</h3><p>Required and optional courses assigned by your organization.</p></div></div></div><div className="resource-list">{(training ?? []).length === 0 && <div className="context-empty"><span><Icon name="spark" /></span><div><strong>No courses assigned</strong><p>When HR assigns training, its status and completion details will appear here.</p></div></div>}{(training ?? []).map((item: any) => <article key={item.id}><span className="metric-icon mint small"><Icon name="spark" size={16} /></span><div><strong>{item.training_courses?.name ?? "Training course"}</strong><p>{item.training_courses?.description ?? "Learning assigned by your organization."}</p><small>{item.training_courses?.is_required ? "Required" : "Optional"}{item.expires_on ? ` · Expires ${item.expires_on}` : ""}</small></div><span className={`badge ${statusBadgeClass(item.status)}`}>{item.status.replace(/_/g," ")}</span></article>)}</div></section>
        <section className="card"><div className="panel-heading"><div><span className="panel-icon"><Icon name="organization" /></span><div><h3>Company assets</h3><p>Equipment currently recorded in your care.</p></div></div></div><div className="resource-list">{(assetAssignments ?? []).length === 0 && <div className="context-empty"><span><Icon name="organization" /></span><div><strong>No equipment assigned</strong><p>Laptops, phones, access cards, keys, uniforms, and other assets will be listed here.</p></div></div>}{(assetAssignments ?? []).map((assignment: any) => <article key={assignment.id}><span className="metric-icon sun small"><Icon name="organization" size={16} /></span><div><strong>{assignment.assets?.name ?? "Company asset"}</strong><p>{assignment.assets?.category?.replace(/_/g," ")}{assignment.assets?.serial_number ? ` · ${assignment.assets.serial_number}` : ""}</p><small>Assigned {new Date(assignment.assigned_at).toLocaleDateString()}</small></div></article>)}</div></section>
      </div>
      <section className="card"><div className="panel-heading"><div><span className="panel-icon"><Icon name="document" /></span><div><h3>Professional certifications</h3><p>Licences and credentials held on your employee record.</p></div></div>{sessionCan(session, "employee.manage") && <Link className="panel-link" href="/admin/employees">Manage employee records <Icon name="arrow-right" size={14} /></Link>}</div><div className="resource-list certifications">{(certifications ?? []).length === 0 && <div className="context-empty"><span><Icon name="document" /></span><div><strong>No certifications recorded</strong><p>Professional licences, issuing bodies, and renewal dates will stay visible here once added.</p></div></div>}{(certifications ?? []).map((certificate) => <article key={certificate.id}><span className="metric-icon coral small"><Icon name="document" size={16} /></span><div><strong>{certificate.name}</strong><p>{certificate.issuing_body ?? "Issuing body not recorded"}</p><small>{certificate.issued_on ? `Issued ${certificate.issued_on}` : "Issue date not recorded"}{certificate.expires_on ? ` · Expires ${certificate.expires_on}` : ""}</small></div>{certificate.expires_on && <span className="badge badge-gold">Renewal tracked</span>}</article>)}</div></section>
    </div>
  );
}
