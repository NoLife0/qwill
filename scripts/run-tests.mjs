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
  const outFile = join(outDir, "tests.cjs");
  await build({
    entryPoints: entries,
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    logLevel: "silent",
  });
  const res = spawnSync(process.execPath, ["--test", outFile], { stdio: "inherit" });
  process.exit(res.status ?? 1);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
