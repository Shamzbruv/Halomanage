// Shared geometry for the Halomanage mark — two connected figures (one for
// the employer, one for the employee) tracing the shape of an "H". This
// file exists because the mark needs to render in two completely different
// ways: as a real inline <svg> for the web app (components/Brand.tsx,
// currentColor-friendly, crisp at any CSS size), and as plain positioned
// <div>s for the file-based icon/social-image routes under app/, which run
// through Next.js's next/og ImageResponse (Satori) and can't consume
// arbitrary React components or CSS custom properties the way normal pages
// can. Both call sites share these exact coordinates so the icon on a
// browser tab and the icon inside the app are unmistakably the same mark.
//
// Coordinates are percentages of a square canvas: a head circle, a capsule
// body, an inward-facing nub, and a feet circle per figure, mirrored across
// the center, with a small connecting circle where the two nubs meet.
export const MARK_SHAPES = {
  leftHead: { left: "17%", top: "7%", width: "22%", height: "22%", radius: "50%" },
  leftBody: { left: "17%", top: "30%", width: "22%", height: "40%", radius: "11%" },
  leftNub: { left: "39%", top: "44.5%", width: "11%", height: "11%", radius: "20%" },
  leftFeet: { left: "17%", top: "71%", width: "22%", height: "22%", radius: "50%" },
  rightHead: { left: "61%", top: "7%", width: "22%", height: "22%", radius: "50%" },
  rightBody: { left: "61%", top: "30%", width: "22%", height: "40%", radius: "11%" },
  rightNub: { left: "50%", top: "44.5%", width: "11%", height: "11%", radius: "20%" },
  rightFeet: { left: "61%", top: "71%", width: "22%", height: "22%", radius: "50%" },
  centerDot: { left: "42%", top: "42%", width: "16%", height: "16%", radius: "50%" },
} as const;

// Used by app/icon.tsx, app/apple-icon.tsx, app/opengraph-image.tsx, and
// app/twitter-image.tsx — every one of them renders through next/og's
// Satori, which requires an explicit `display` on every node (it doesn't
// implement the normal CSS box model) and can't read CSS custom
// properties, so colors are passed in as plain hex rather than var(...).
export function MarkShapesForOg({ navy, teal }: { navy: string; teal: string }) {
  const shape = (key: keyof typeof MARK_SHAPES, color: string) => (
    <div
      key={key}
      style={{
        position: "absolute",
        display: "flex",
        background: color,
        ...MARK_SHAPES[key],
      }}
    />
  );
  return (
    <div style={{ position: "relative", display: "flex", width: "100%", height: "100%" }}>
      {shape("leftHead", navy)}
      {shape("leftBody", navy)}
      {shape("leftNub", navy)}
      {shape("leftFeet", navy)}
      {shape("rightHead", teal)}
      {shape("rightBody", teal)}
      {shape("rightNub", teal)}
      {shape("rightFeet", teal)}
      {shape("centerDot", teal)}
    </div>
  );
}

export const BRAND_NAVY = "#101B3D";
export const BRAND_NAVY_DARK = "#0A1428";
export const BRAND_TEAL = "#129C86";

// Shared by app/opengraph-image.tsx and app/twitter-image.tsx — the banner
// shown when a Halomanage link is pasted into Slack, WhatsApp, iMessage,
// LinkedIn, X, or any other link-unfurling client.
export function OgBanner() {
  const badgeStyle = {
    display: "flex",
    alignItems: "center",
    padding: "10px 20px",
    borderRadius: "999px",
    border: "1.5px solid rgba(255,255,255,0.22)",
    color: "#bcd4cd",
    fontSize: 24,
  };
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        width: "100%",
        height: "100%",
        padding: "72px 80px",
        background: `linear-gradient(135deg, ${BRAND_NAVY} 0%, ${BRAND_NAVY_DARK} 100%)`,
        color: "#ffffff",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
        <div style={{ display: "flex", position: "relative", width: 74, height: 74 }}>
          <MarkShapesForOg navy="#ffffff" teal={BRAND_TEAL} />
        </div>
        <div style={{ display: "flex", fontSize: 44, fontWeight: 700, letterSpacing: "-0.02em" }}>
          <span>Halo</span>
          <span style={{ color: BRAND_TEAL }}>manage</span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 920 }}>
        <div style={{ display: "flex", fontSize: 56, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.08 }}>
          People operations, beautifully organized.
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 10 }}>
          {["Employee records", "Time & leave", "Onboarding", "Performance", "Documents"].map((label) => (
            <div key={label} style={badgeStyle}>
              {label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
