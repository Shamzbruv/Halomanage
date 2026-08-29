"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";

const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

// Ref: supabase/migrations/20260829142948_employee_experience_branding.sql —
// update_organization_branding() saves slug/title/message/logo/colors in one
// transaction, so a failed logo upload never leaves the portal half-updated.
// The bucket is public (a sign-in page renders before authentication), but
// only organization.manage holders may write to it — enforced by Storage
// RLS keyed on the {organization_id}/... path prefix, not by client code.
export function OrganizationPortalCard({
  organizationId,
  organizationName,
  initialSlug,
  initialTitle,
  initialMessage,
  initialLogoUrl,
  initialPrimaryColor,
  initialAccentColor,
  siteUrl,
}: {
  organizationId: string;
  organizationName: string;
  initialSlug: string;
  initialTitle: string;
  initialMessage: string;
  initialLogoUrl: string | null;
  initialPrimaryColor: string;
  initialAccentColor: string;
  siteUrl: string;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [slug, setSlug] = useState(initialSlug);
  const [title, setTitle] = useState(initialTitle);
  const [message, setMessage] = useState(initialMessage);
  const [primaryColor, setPrimaryColor] = useState(initialPrimaryColor);
  const [accentColor, setAccentColor] = useState(initialAccentColor);
  const [logoPath, setLogoPath] = useState<string | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(initialLogoUrl);
  const [savedSlug, setSavedSlug] = useState(initialSlug);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const path = `/portal/${savedSlug}`;
  const displayUrl = siteUrl ? `${siteUrl.replace(/\/$/, "")}${path}` : path;

  async function copyLink() {
    const fullUrl = `${window.location.origin}${path}`;
    await navigator.clipboard.writeText(fullUrl);
    setStatus("Employee portal link copied.");
  }

  async function uploadLogo(file: File) {
    const extension = LOGO_TYPES.get(file.type);
    if (!extension) {
      setError("Choose a PNG, JPG, or WebP image for the logo.");
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setError("Your logo must be 2 MB or smaller.");
      return;
    }
    setUploadingLogo(true);
    setError(null);
    const supabase = createClient();
    const objectPath = `${organizationId}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage
      .from("organization-branding")
      .upload(objectPath, file, { cacheControl: "3600", contentType: file.type, upsert: false });

    if (uploadError) {
      setError(uploadError.message);
      setUploadingLogo(false);
      return;
    }

    const oldPath = logoPath;
    setLogoPath(objectPath);
    setLogoPreviewUrl(supabase.storage.from("organization-branding").getPublicUrl(objectPath).data.publicUrl);
    if (oldPath) {
      await supabase.storage.from("organization-branding").remove([oldPath]);
    }
    setUploadingLogo(false);
  }

  async function saveBranding(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setStatus(null);
    const supabase = createClient();
    const { data, error: updateError } = await supabase.rpc("update_organization_branding", {
      p_organization_id: organizationId,
      p_slug: slug,
      p_portal_enabled: true,
      p_portal_title: title,
      p_portal_message: message,
      p_logo_path: logoPath,
      p_primary_color: primaryColor,
      p_accent_color: accentColor,
    });

    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }

    const updated = Array.isArray(data) ? data[0] : data;
    const updatedSlug = String(updated?.slug ?? slug);
    setSavedSlug(updatedSlug);
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
          <form className="modal-card portal-settings-modal" onSubmit={saveBranding}>
            <div className="modal-card-head"><div><span className="eyebrow">Portal settings</span><h2 id="portal-settings-title">Customize your employee front door</h2></div><button className="icon-button" type="button" aria-label="Close portal settings" onClick={() => setEditing(false)}><Icon name="x" /></button></div>

            <div className="flex items-center gap-4">
              <div className="profile-photo" aria-hidden="true">
                {logoPreviewUrl ? <img src={logoPreviewUrl} alt="" /> : <span>{organizationName.slice(0, 2).toUpperCase()}</span>}
              </div>
              <div>
                <label className="btn-secondary cursor-pointer" htmlFor="portal-logo-input">
                  <Icon name="upload" size={16} /> {uploadingLogo ? "Uploading…" : "Upload logo"}
                </label>
                <input
                  ref={fileInputRef}
                  id="portal-logo-input"
                  className="sr-only"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={uploadingLogo}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadLogo(file);
                  }}
                />
                <p className="field-help">PNG, JPG, or WebP. Maximum 2 MB. Shown on your employee sign-in page.</p>
              </div>
            </div>

            <div><label className="label" htmlFor="portal-address">Portal address</label><div className="portal-slug-field"><span>/portal/</span><input id="portal-address" className="input" required minLength={3} maxLength={50} value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} /></div><p className="field-help">Use a short, recognizable address such as <strong>icssportal-halomanage</strong>.</p></div>
            <div><label className="label" htmlFor="portal-title">Welcome heading</label><input id="portal-title" className="input" required maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} /></div>
            <div><label className="label" htmlFor="portal-message">Welcome message</label><textarea id="portal-message" className="input min-h-24" required maxLength={240} value={message} onChange={(event) => setMessage(event.target.value)} /></div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="portal-primary-color">Primary color</label>
                <div className="flex items-center gap-2">
                  <input id="portal-primary-color" type="color" value={primaryColor} onChange={(event) => setPrimaryColor(event.target.value.toUpperCase())} />
                  <input className="input" value={primaryColor} maxLength={7} onChange={(event) => setPrimaryColor(event.target.value.toUpperCase())} />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="portal-accent-color">Accent color</label>
                <div className="flex items-center gap-2">
                  <input id="portal-accent-color" type="color" value={accentColor} onChange={(event) => setAccentColor(event.target.value.toUpperCase())} />
                  <input className="input" value={accentColor} maxLength={7} onChange={(event) => setAccentColor(event.target.value.toUpperCase())} />
                </div>
              </div>
            </div>

            {error && <p className="alert-error" role="alert">{error}</p>}
            <div className="modal-actions"><button className="btn-secondary" type="button" onClick={() => setEditing(false)}>Cancel</button><button className="btn-primary" disabled={loading || uploadingLogo} type="submit">{loading ? "Saving…" : "Save portal"}</button></div>
          </form>
        </div>
      )}
    </section>
  );
}
