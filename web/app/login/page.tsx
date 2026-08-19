import { LoginForm } from "@/components/LoginForm";

// Force this page to render per-request instead of being statically
// prerendered at build time. Without this, Next.js has no dynamic marker
// (no cookies()/headers() call anywhere in the tree) and tries to
// prerender it at build time — which runs LoginForm's createClient() call
// on the server during `next build`, before any real
// NEXT_PUBLIC_SUPABASE_URL/ANON_KEY are necessarily available in the build
// environment (they were, locally, only because dummy values were passed
// inline for every verification build in this repo's history — a hosting
// platform's build step has no reason to have them). @supabase/ssr throws
// immediately when those are missing, which fails the whole build.
//
// `dynamic` route-segment config is only honored in a Server Component
// file, which is why the actual form (a Client Component, since it needs
// state/handlers) lives in components/LoginForm.tsx and this file just
// renders it.
export const dynamic = "force-dynamic";

export default function LoginPage() {
  return <LoginForm />;
}
