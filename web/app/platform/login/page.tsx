import { PlatformLoginForm } from "@/components/platform/PlatformLoginForm";

// Force per-request rendering rather than build-time static prerendering —
// see the identical comment on app/login/page.tsx. Without this,
// PlatformLoginForm's createClient() call runs during `next build`, before
// a hosting platform's build step necessarily has real Supabase env vars.
export const dynamic = "force-dynamic";

export default function PlatformLoginPage() {
  return <PlatformLoginForm />;
}
