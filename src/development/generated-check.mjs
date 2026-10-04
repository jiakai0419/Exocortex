import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function treeFiles(root) {
  const files = new Map();
  const visit = (directory, prefix = "") => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT" && !prefix) return; throw error; }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else files.set(relative, entry.isFile() ? readFileSync(absolute) : null);
    }
  };
  visit(root);
  return files;
}

/** Compare the complete output set and bytes, including declarations and maps. */
export function compareGeneratedTrees(expectedRoot, actualRoot) {
  const expected = treeFiles(expectedRoot);
  const actual = treeFiles(actualRoot);
  const differences = [];
  for (const name of [...new Set([...expected.keys(), ...actual.keys()])].sort()) {
    if (!expected.has(name)) differences.push(`unexpected dist/${name}`);
    else if (!actual.has(name)) differences.push(`missing dist/${name}`);
    else if (expected.get(name) === null || actual.get(name) === null || !expected.get(name).equals(actual.get(name))) {
      differences.push(`different dist/${name}`);
    }
  }
  return differences;
}

/** A check never rewrites the running checkout's dist directory. */
export function checkGeneratedFiles(projectRoot, { compilerPath = join(projectRoot, "node_modules/typescript/bin/tsc"), stdout = process.stdout, stderr = process.stderr } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), "exocortex-generated-check-"));
  try {
    const generated = join(temporary, "dist");
    const result = spawnSync(process.execPath, [compilerPath, "-p", join(projectRoot, "tsconfig.build.json"), "--outDir", generated, "--incremental", "false"], {
      cwd: projectRoot, encoding: "utf8",
    });
    if (result.status !== 0 || result.error || result.signal) {
      stderr.write("Clean generated-file build failed.\n");
      stderr.write(String(result.stdout || result.stderr || ""));
      return 1;
    }
    const differences = compareGeneratedTrees(generated, join(projectRoot, "dist"));
    if (differences.length) {
      stderr.write(`${differences.join("\n")}\nRun npm run build and remove obsolete generated files.\n`);
      return 1;
    }
    stdout.write("Generated file set and contents match a clean build.\n");
    return 0;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
