"use client";
import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { RewardDialog } from "./RewardDialog";
import type {
  RewardVendor,
  RewardProduct,
  RewardProvider,
} from "@/lib/rewards";
export function RewardCatalogEditor({
  organizationId,
  mode,
  initial,
  providers = [],
  vendors = [],
}: {
  organizationId: string;
  mode: "vendor" | "product";
  initial?: RewardVendor | RewardProduct;
  providers?: RewardProvider[];
  vendors?: { id: string; name: string }[];
}) {
  const router = useRouter(),
    formId = useId(),
    submitting = useRef(false);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [track, setTrack] = useState(
      initial && "inventory_quantity" in initial
        ? initial.inventory_quantity !== null
        : false,
    );
  const title = `${initial ? "Edit" : "New"} ${mode === "vendor" ? "vendor" : "reward"}`;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget),
      data: Record<string, unknown> = {
        name: form.get("name"),
        description: form.get("description"),
        is_active: form.get("is_active") === "on",
      };
    if (mode === "vendor")
      Object.assign(data, {
        provider_id: form.get("provider_id"),
        contact_name: form.get("contact_name"),
        contact_email: form.get("contact_email"),
        contact_phone: form.get("contact_phone"),
      });
    else
      Object.assign(data, {
        vendor_id: form.get("vendor_id"),
        points_cost: Number(form.get("points_cost")),
        image_url: form.get("image_url"),
        terms: form.get("terms"),
        inventory_quantity: track
          ? Number(form.get("inventory_quantity"))
          : null,
      });
    try {
      const { error } = await createClient().rpc(
        mode === "vendor" ? "save_reward_vendor" : "save_reward_product",
        {
          p_organization_id: organizationId,
          p_data: data,
          ...(mode === "vendor"
            ? { p_vendor_id: initial?.id ?? null }
            : { p_product_id: initial?.id ?? null }),
          p_expected_updated_at: initial?.updated_at ?? null,
        },
      );
      if (error) throw error;
      setOpen(false);
      router.refresh();
    } catch (error) {
      setError(
        (error as { message?: string }).message ??
          "Unable to save. Refresh to check whether it was saved before creating again.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const vendor =
      mode === "vendor" ? (initial as RewardVendor | undefined) : undefined,
    product =
      mode === "product" ? (initial as RewardProduct | undefined) : undefined;
  return (
    <>
      <button
        type="button"
        className={initial ? "btn-secondary" : "btn-primary"}
        disabled={mode === "product" && !vendors.length}
        onClick={() => {
          setError(null);
          setTrack(
            initial && "inventory_quantity" in initial
              ? initial.inventory_quantity !== null
              : false,
          );
          setOpen(true);
        }}
      >
        {title}
      </button>
      <RewardDialog
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        busy={busy}
      >
        <form
          key={initial?.updated_at ?? "new"}
          id={formId}
          onSubmit={submit}
          className="space-y-3"
        >
          <fieldset disabled={busy} className="space-y-3">
            <label className="label">
              Name
              <input
                name="name"
                required
                maxLength={120}
                className="input"
                defaultValue={initial?.name}
              />
            </label>
            {mode === "vendor" ? (
              <>
                <label className="label">
                  Fulfillment
                  <select
                    name="provider_id"
                    required
                    className="input"
                    defaultValue={vendor?.provider_id ?? providers[0]?.id ?? ""}
                  >
                    {!providers.some((p) => p.id === vendor?.provider_id) &&
                      vendor?.provider_id && (
                        <option value={vendor.provider_id} disabled>
                          Provider unavailable — choose manual
                        </option>
                      )}
                    {providers.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="label">
                  HR contact name
                  <input
                    name="contact_name"
                    maxLength={120}
                    className="input"
                    defaultValue={vendor?.contact_name ?? ""}
                  />
                </label>
                <label className="label">
                  HR contact email
                  <input
                    name="contact_email"
                    type="email"
                    maxLength={254}
                    className="input"
                    defaultValue={vendor?.contact_email ?? ""}
                  />
                </label>
                <label className="label">
                  HR contact phone
                  <input
                    name="contact_phone"
                    maxLength={60}
                    className="input"
                    defaultValue={vendor?.contact_phone ?? ""}
                  />
                </label>
                <p className="text-sm">
                  Contact details are available to authorized catalog and
                  fulfillment staff.
                </p>
              </>
            ) : (
              <>
                <label className="label">
                  Vendor
                  <select
                    name="vendor_id"
                    required
                    className="input"
                    defaultValue={product?.vendor_id ?? ""}
                  >
                    <option value="" disabled>
                      Select a vendor
                    </option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="label">
                  Points cost
                  <input
                    name="points_cost"
                    required
                    type="number"
                    min={1}
                    max={1000000}
                    step={1}
                    className="input"
                    defaultValue={product?.points_cost}
                  />
                </label>
                <label className="label">
                  Collection, eligibility and expiry terms
                  <textarea
                    name="terms"
                    maxLength={3000}
                    rows={4}
                    className="input"
                    defaultValue={product?.terms ?? ""}
                  />
                </label>
                <p className="text-sm">
                  Include delivery arrangements, any location limits and voucher
                  expiry. Requests keep the terms shown at confirmation. HR must
                  review benefit tax treatment separately.
                </p>
                <label className="label">
                  Image URL (HTTPS, optional)
                  <input
                    name="image_url"
                    type="url"
                    pattern="https://.*"
                    maxLength={2000}
                    className="input"
                    defaultValue={product?.image_url ?? ""}
                  />
                </label>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={track}
                    onChange={(e) => setTrack(e.target.checked)}
                  />
                  Track limited stock
                </label>
                {track && (
                  <label className="label">
                    Available stock (excludes already reserved rewards)
                    <input
                      name="inventory_quantity"
                      required
                      type="number"
                      min={0}
                      max={1000000}
                      step={1}
                      className="input"
                      defaultValue={product?.inventory_quantity ?? 0}
                    />
                  </label>
                )}
                <p className="text-sm">
                  Stock changes are checked against the version you opened.
                  Finish pending requests before changing between tracked and
                  unlimited stock.
                </p>
              </>
            )}
            <label className="label">
              Description
              <textarea
                name="description"
                maxLength={2000}
                rows={3}
                className="input"
                defaultValue={initial?.description ?? ""}
              />
            </label>
            <label className="flex gap-2">
              <input
                name="is_active"
                type="checkbox"
                defaultChecked={initial?.is_active ?? true}
              />
              Active — uncheck to archive
            </label>
            <p className="text-sm">
              Archiving stops new requests; existing requests and receipts
              remain.
            </p>
          </fieldset>
          {error && (
            <p role="alert" className="alert-error">
              {error}
            </p>
          )}
          <button className="btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      </RewardDialog>
    </>
  );
}
