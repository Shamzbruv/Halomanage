import { ImageResponse } from "next/og";
import { MarkShapesForOg, BRAND_NAVY, BRAND_TEAL } from "@/lib/brand-mark";

// Next.js's file-based icon convention: this route is served at /icon and
// automatically wired into the page <head> as the browser-tab favicon —
// no favicon.ico needed. Transparent background since a favicon sits
// directly on the browser's own chrome.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%" }}>
        <MarkShapesForOg navy={BRAND_NAVY} teal={BRAND_TEAL} />
      </div>
    ),
    { ...size },
  );
}
