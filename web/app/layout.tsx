import type { Metadata } from "next";
import { Playfair_Display, Inter } from "next/font/google";
import "./globals.css";

// Playfair Display gives headings/the wordmark the engraved, "minted"
// character a royal/gold theme wants; Inter stays on body copy so dense
// tables and forms remain highly legible under a skeuomorphic surface.
const display = Playfair_Display({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-display",
});

const body = Inter({
  subsets: ["latin"],
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: "Halomanage",
  description: "Employee lifecycle & workforce management HRIS",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
