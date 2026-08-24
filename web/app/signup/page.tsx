import type { Metadata } from "next";
import { AuthScreen } from "@/components/AuthScreen";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create your workspace" };

export default function SignupPage() {
  return <AuthScreen mode="sign-up" />;
}
