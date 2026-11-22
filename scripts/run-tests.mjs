/**
 * Test runner: bundles test/*.test.ts with esbuild (already a transitive
 * dependency via vite) into a temp file and runs it under node --test.
 * No extra test framework is installed.
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const testDir = join(root, "test");
const entries = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join(testDir, f));
if (entries.length === 0) {
  console.log("No tests found.");
  process.exit(0);
}

const outDir = mkdtempSync(join(tmpdir(), "qwill-tests-"));
try {
  // One bundle per test file (esbuild needs `outdir` for multiple entries).
  await build({
    entryPoints: entries,
    bundle: true,
    platform: "node",
    format: "cjs",
    outdir: outDir,
    logLevel: "silent",
  });
  const outFiles = entries.map((f) =>
    join(outDir, f.slice(testDir.length + 1).replace(/\.ts$/, ".js")),
  );
  const res = spawnSync(process.execPath, ["--test", ...outFiles], {
    stdio: "inherit",
  });
  process.exit(res.status ?? 1);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
