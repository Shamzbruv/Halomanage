"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Icon } from "@/components/Icon";

export type VendorOption = { id: string; name: string };

export function NewRewardProductForm({ organizationId, vendors }: { organizationId: string; vendors: VendorOption[] }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [pointsCost, setPointsCost] = useState("1000");
  const [trackInventory, setTrackInventory] = useState(false);
  const [inventoryQuantity, setInventoryQuantity] = useState("10");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: insertError } = await supabase.from("reward_products").insert({
      organization_id: organizationId,
      vendor_id: vendorId,
      name,
      description: description || null,
      image_url: imageUrl || null,
      points_cost: Number(pointsCost),
      inventory_quantity: trackInventory ? Number(inventoryQuantity) : null,
    });
    if (insertError) {
      setError(insertError.message);
      setLoading(false);
      return;
    }
    setOpen(false);
    setLoading(false);
    router.refresh();
  }

  if (vendors.length === 0) {
    return <p className="text-sm text-stone-400">Add a vendor first before creating a reward.</p>;
  }

  if (!open) {
    return <button type="button" className="btn-primary" onClick={() => setOpen(true)}><Icon name="spark" size={16} /> New reward</button>;
  }

  return (
    <div className="modal-layer" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="Close dialog" onClick={() => setOpen(false)} />
      <form onSubmit={handleSubmit} className="modal-card space-y-3" role="dialog" aria-modal="true" aria-labelledby="new-product-title">
        <div className="modal-head"><div><span className="eyebrow">Rewards catalog</span><h3 id="new-product-title">New reward</h3></div><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setOpen(false)}><Icon name="x" size={18} /></button></div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="product-vendor">Vendor</label>
            <select id="product-vendor" className="input" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <div><label className="label" htmlFor="product-points">Points cost</label><input id="product-points" type="number" min="1" required className="input" value={pointsCost} onChange={(e) => setPointsCost(e.target.value)} /></div>
          <div className="col-span-2"><label className="label" htmlFor="product-name">Name</label><input id="product-name" required className="input" placeholder="$25 Fontana Voucher" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="col-span-2"><label className="label" htmlFor="product-description">Description</label><textarea id="product-description" className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="col-span-2"><label className="label" htmlFor="product-image">Image URL <span className="font-normal text-stone-500">(optional)</span></label><input id="product-image" type="url" placeholder="https://" className="input" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} /></div>
          <div className="col-span-2 flex items-center gap-2">
            <input id="product-track-inventory" type="checkbox" checked={trackInventory} onChange={(e) => setTrackInventory(e.target.checked)} />
            <label htmlFor="product-track-inventory" className="text-sm text-stone-700">Track limited stock</label>
          </div>
          {trackInventory && (
            <div><label className="label" htmlFor="product-inventory">Quantity available</label><input id="product-inventory" type="number" min="0" className="input" value={inventoryQuantity} onChange={(e) => setInventoryQuantity(e.target.value)} /></div>
          )}
        </div>
        {error && <p className="alert-error">{error}</p>}
        <div className="flex gap-2"><button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Create"}</button><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </div>
  );
}
