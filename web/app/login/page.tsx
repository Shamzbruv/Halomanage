import { AuthScreen } from "@/components/AuthScreen";
import type { Metadata } from "next";

// Force this page to render per-request instead of being statically
// prerendered at build time. Without this, Next.js has no dynamic marker
// (no cookies()/headers() call anywhere in the tree) and tries to
// prerender it at build time — which runs AuthScreen's createClient() call
// on the server during `next build`, before any real
// NEXT_PUBLIC_SUPABASE_URL/ANON_KEY are necessarily available in the build
// environment (they were, locally, only because dummy values were passed
// inline for every verification build in this repo's history — a hosting
// platform's build step has no reason to have them). @supabase/ssr throws
// immediately when those are missing, which fails the whole build.
//
// `dynamic` route-segment config is only honored in a Server Component
// file, which is why the actual interactive part (a Client Component,
// since it needs state/handlers and an RPC call before rendering) lives in
// components/AuthScreen.tsx (which itself picks between LoginForm and
// CreateOrganizationForm) and this file just renders it.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return <AuthScreen />;
}
