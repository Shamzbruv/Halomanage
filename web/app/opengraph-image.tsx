import { ImageResponse } from "next/og";
import { OgBanner } from "@/lib/brand-mark";

// app/opengraph-image → Next.js automatically adds the corresponding
// <meta property="og:image"> tags to every page under this route segment
// that doesn't define its own. This is what Slack, WhatsApp, iMessage, and
// LinkedIn render when someone shares a Halomanage link.
export const alt = "Halomanage — People operations, beautifully organized.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(<OgBanner />, { ...size });
}
