import { ImageResponse } from "next/og";
import { OgBanner } from "@/lib/brand-mark";

// Next.js does not fall back to opengraph-image for Twitter/X cards on its
// own — this sibling file is what wires up <meta name="twitter:image">.
// Same banner as app/opengraph-image.tsx; kept as two thin files rather
// than one so each platform's convention resolves independently instead of
// depending on undocumented fallback behavior.
export const alt = "Halomanage — People operations, beautifully organized.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function TwitterImage() {
  return new ImageResponse(<OgBanner />, { ...size });
}
