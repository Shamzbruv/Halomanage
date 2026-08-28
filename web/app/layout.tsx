import type { Metadata, Viewport } from "next";
import { DM_Sans, Newsreader } from "next/font/google";
import "./globals.css";

const display = Newsreader({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
});

const body = DM_Sans({
  subsets: ["latin"],
  variable: "--font-body",
});

// metadataBase turns the relative image URLs Next.js generates for the
// file-based icon/opengraph-image/twitter-image routes (app/icon.tsx etc.)
// into absolute ones — without it, a link unfurled by Slack/WhatsApp/
// LinkedIn would try to fetch "/opengraph-image" against their own domain
// instead of Halomanage's. Reuses the same NEXT_PUBLIC_SITE_URL convention
// already used for the employee portal link (components/OrganizationPortalCard.tsx).
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://halomanage-production.up.railway.app";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Halomanage — People operations, beautifully organized",
    template: "%s — Halomanage",
  },
  description: "A secure, connected workspace for the complete employee lifecycle.",
  openGraph: {
    type: "website",
    siteName: "Halomanage",
    title: "Halomanage — People operations, beautifully organized",
    description: "A secure, connected workspace for the complete employee lifecycle.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Halomanage — People operations, beautifully organized",
    description: "A secure, connected workspace for the complete employee lifecycle.",
  },
};

export const viewport: Viewport = {
  themeColor: "#101B3D",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`} suppressHydrationWarning>
      <body>
        <a className="skip-link" href="#main-content">Skip to main content</a>
        {children}
      </body>
    </html>
  );
}
