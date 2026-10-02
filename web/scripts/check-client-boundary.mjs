// Fails if a server module imports a non-component *value* from a
// "use client" module.
//
// Next.js turns every export of a "use client" module into a client
// reference when a Server Component imports it. Components work (that's
// the point), but a string/object/function imported that way is not the
// real value on the server — TypeScript and `next build` both accept it,
// and it only fails at request time. That is exactly how My Profile broke
// in production on 2026-10-03 (PERSONAL_INFO_COLUMNS). Shared values belong
// in lib/.
//
// Heuristic: exported names starting with an uppercase letter followed by a
// lowercase letter are treated as components; ALL_CAPS constants and
// camelCase values are flagged. `import type` / `type X` specifiers are fine.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs = ["app", "components", "lib"];
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) files.push(full);
  }
}
for (const dir of dirs) walk(path.join(root, dir));

const isClient = (source) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source);
const sources = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));

function resolveImport(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = path.join(root, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, path.join(base, "index.tsx"), path.join(base, "index.ts")]) {
    if (sources.has(candidate)) return candidate;
  }
  return null;
}

const looksLikeComponent = (name) => /^[A-Z][a-z]/.test(name);
const problems = [];
for (const [file, source] of sources) {
  if (isClient(source)) continue;
  for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
    if (match[1]) continue;
    const target = resolveImport(file, match[3]);
    if (!target || !isClient(sources.get(target))) continue;
    for (const raw of match[2].split(",")) {
      const spec = raw.trim();
      if (!spec || spec.startsWith("type ")) continue;
      const name = spec.split(/\s+as\s+/)[0].trim();
      if (!looksLikeComponent(name)) {
        problems.push(`${path.relative(root, file)}: imports value "${name}" from client module ${match[3]}`);
      }
    }
  }
}

if (problems.length) {
  console.error("Server modules importing non-component values from \"use client\" modules (move them to lib/):");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Client boundary OK (${files.length} files checked).`);
