"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

export function AvatarUpload({
  employeeId,
  organizationId,
  currentPath,
  currentUrl,
  employeeName,
}: {
  employeeId: string;
  organizationId: string;
  currentPath: string | null;
  currentUrl: string | null;
  employeeName: string;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [previewUrl, setPreviewUrl] = useState(currentUrl);
  const [savedPath, setSavedPath] = useState(currentPath);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const initials = employeeName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  async function upload(file: File) {
    const extension = ALLOWED_TYPES.get(file.type);
    if (!extension) {
      setError("Choose a JPG, PNG, or WebP image.");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setError("Your photo must be 5 MB or smaller.");
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    const supabase = createClient();
    const objectPath = `${organizationId}/${employeeId}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage
      .from("employee-avatars")
      .upload(objectPath, file, { cacheControl: "3600", contentType: file.type, upsert: false });

    if (uploadError) {
      setError(uploadError.message);
      setLoading(false);
      return;
    }

    const { error: updateError } = await supabase
      .from("employees")
      .update({ avatar_url: objectPath })
      .eq("id", employeeId);

    if (updateError) {
      await supabase.storage.from("employee-avatars").remove([objectPath]);
      setError(updateError.message);
      setLoading(false);
      return;
    }

    const oldPath = savedPath;
    if (oldPath && oldPath !== objectPath) {
      await supabase.storage.from("employee-avatars").remove([oldPath]);
    }

    setSavedPath(objectPath);
    setPreviewUrl(URL.createObjectURL(file));
    setStatus("Profile photo updated.");
    setLoading(false);
    router.refresh();
  }

  async function remove() {
    if (!savedPath) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("employees")
      .update({ avatar_url: null })
      .eq("id", employeeId);

    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }

    await supabase.storage.from("employee-avatars").remove([savedPath]);
    setSavedPath(null);
    setPreviewUrl(null);
    setStatus("Profile photo removed.");
    setLoading(false);
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  return (
    <section className="flex flex-col gap-4 sm:flex-row sm:items-center" aria-labelledby={`${inputId}-heading`}>
      <div className="profile-photo" aria-hidden="true">
        {previewUrl ? <img src={previewUrl} alt="" /> : <span>{initials}</span>}
      </div>
      <div className="space-y-2">
        <div>
          <h3 id={`${inputId}-heading`} className="text-sm font-semibold text-stone-900">Profile photo</h3>
          <p className="text-xs text-stone-500">JPG, PNG, or WebP. Maximum 5 MB. Photos stay private to your organization.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="btn-secondary cursor-pointer" htmlFor={inputId} aria-disabled={loading}>
            <Icon name="upload" size={16} /> {loading ? "Uploading…" : savedPath ? "Replace photo" : "Upload photo"}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            className="sr-only"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={loading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          {savedPath && (
            <button type="button" className="btn-secondary" disabled={loading} onClick={() => void remove()}>
              Remove
            </button>
          )}
        </div>
        {error && <p className="alert-error" role="alert">{error}</p>}
        {status && <p className="text-xs text-emerald-700" role="status">{status}</p>}
      </div>
    </section>
  );
}
