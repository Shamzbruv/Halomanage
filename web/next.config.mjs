import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep current developer sessions on their existing .next cache while
  // production verification uses a clean directory. This also avoids stale
  // manifests when the framework major version changes.
  distDir: "build",
  // This repo has lockfiles at the root, web/, and supabase/tests/pglite/
  // (three independent Node projects sharing one repo, not a workspace) —
  // Next.js's root-detection heuristic sees the extra lockfiles and warns
  // it "may not be correct" about where the project root is, which affects
  // output file tracing for the standalone/serverless build. Pin it
  // explicitly to this directory rather than let it guess.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
