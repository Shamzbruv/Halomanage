import type { MetadataRoute } from "next";

// Basic PWA manifest — enough for "Add to Home Screen" on mobile browsers
// to pick up the right name, color, and icon. Halomanage isn't a real
// installable PWA yet (no service worker/offline support), so this
// deliberately doesn't try to be a full app-icon pipeline: it points at
// the one favicon size the /icon route already generates rather than
// shipping dedicated 192/512 assets for an install flow that doesn't
// exist yet. Revisit with real maskable icons if/when PWA installability
// becomes an actual goal.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Halomanage — HR & Employee Management",
    short_name: "Halomanage",
    description: "A secure, connected workspace for the complete employee lifecycle.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#101B3D",
    icons: [{ src: "/icon", sizes: "32x32", type: "image/png" }],
  };
}
