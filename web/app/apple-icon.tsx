import { ImageResponse } from "next/og";
import { MarkShapesForOg, BRAND_NAVY, BRAND_TEAL } from "@/lib/brand-mark";

// iOS home-screen icon (app/apple-icon → auto-wired as
// <link rel="apple-touch-icon">). Unlike the browser favicon this needs an
// opaque background and inset padding — iOS lays this straight onto a home
// screen tile and applies its own corner rounding, so a transparent or
// edge-to-edge icon looks cut off next to every other app's icon.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          background: "#ffffff",
          padding: "22px",
        }}
      >
        <MarkShapesForOg navy={BRAND_NAVY} teal={BRAND_TEAL} />
      </div>
    ),
    { ...size },
  );
}
