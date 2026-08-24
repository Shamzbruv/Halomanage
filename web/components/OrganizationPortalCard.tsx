"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";

export function OrganizationPortalCard({
  organizationId,
  organizationName,
  initialSlug,
  initialTitle,
  initialMessage,
  siteUrl,
}: {
  organizationId: string;
  organizationName: string;
  initialSlug: string;
  initialTitle: string;
  initialMessage: string;
  siteUrl: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [slug, setSlug] = useState(initialSlug);
  const [title, setTitle] = useState(initialTitle);
  const [message, setMessage] = useState(initialMessage);
  const [savedSlug, setSavedSlug] = useState(initialSlug);
  const [savedTitle, setSavedTitle] = useState(initialTitle);
  const [savedMessage, setSavedMessage] = useState(initialMessage);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const path = `/portal/${savedSlug}`;
  const displayUrl = siteUrl ? `${siteUrl.replace(/\/$/, "")}${path}` : path;

  async function copyLink() {
    const fullUrl = `${window.location.origin}${path}`;
    await navigator.clipboard.writeText(fullUrl);
    setStatus("Employee portal link copied.");
  }

  async function savePortal(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setStatus(null);
    const supabase = createClient();
    const { data, error: updateError } = await supabase.rpc("update_organization_portal", {
      p_organization_id: organizationId,
      p_slug: slug,
      p_portal_title: title,
      p_portal_message: message,
    });

    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }

    const updated = Array.isArray(data) ? data[0] : data;
    const updatedSlug = String(updated?.slug ?? slug);
    setSavedSlug(updatedSlug);
    setSavedTitle(title);
    setSavedMessage(message);
    setSlug(updatedSlug);
    setEditing(false);
    setLoading(false);
    setStatus("Employee portal updated.");
    router.refresh();
  }

  return (
    <section className="portal-share-card">
      <div className="portal-share-main">
        <span className="portal-share-icon"><Icon name="shield" size={23} /></span>
        <div>
          <span className="eyebrow">Employee sign-in link</span>
          <h2>Give your team one clear front door.</h2>
          <p>Employees use this organization-specific page to sign in, start their shift, request leave, complete onboarding, and manage their account.</p>
        </div>
      </div>
      <div className="portal-link-box">
        <div><small>{organizationName} employee portal</small><strong>{displayUrl}</strong></div>
        <div className="portal-link-actions">
          <a className="btn-secondary" href={path} target="_blank" rel="noreferrer">Preview</a>
          <button className="btn-primary" type="button" onClick={copyLink}>Copy link</button>
          <button className="icon-button" type="button" aria-label="Customize employee portal" onClick={() => { setEditing(true); setError(null); setStatus(null); }}><Icon name="settings" size={18} /></button>
        </div>
      </div>
      {status && <p className="portal-card-status" role="status"><Icon name="check" size={15} /> {status}</p>}

      {editing && (
        <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby="portal-settings-title">
          <button className="modal-backdrop" type="button" aria-label="Close portal settings" onClick={() => setEditing(false)} />
          <form className="modal-card portal-settings-modal" onSubmit={savePortal}>
            <div className="modal-card-head"><div><span className="eyebrow">Portal settings</span><h2 id="portal-settings-title">Customize your employee front door</h2></div><button className="icon-button" type="button" aria-label="Close portal settings" onClick={() => setEditing(false)}><Icon name="x" /></button></div>
            <div><label className="label" htmlFor="portal-address">Portal address</label><div className="portal-slug-field"><span>/portal/</span><input id="portal-address" className="input" required minLength={3} maxLength={50} value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} /></div><p className="field-help">Use a short, recognizable address such as <strong>icssportal-halomanage</strong>.</p></div>
            <div><label className="label" htmlFor="portal-title">Welcome heading</label><input id="portal-title" className="input" required maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} /></div>
            <div><label className="label" htmlFor="portal-message">Welcome message</label><textarea id="portal-message" className="input min-h-24" required maxLength={240} value={message} onChange={(event) => setMessage(event.target.value)} /></div>
            {error && <p className="alert-error" role="alert">{error}</p>}
            <div className="modal-actions"><button className="btn-secondary" type="button" onClick={() => { setSlug(savedSlug); setTitle(savedTitle); setMessage(savedMessage); setEditing(false); }}>Cancel</button><button className="btn-primary" disabled={loading} type="submit">{loading ? "Saving…" : "Save portal"}</button></div>
          </form>
        </div>
      )}
    </section>
  );
}
