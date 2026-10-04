#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["bin", "tools", "src", "dist"];

function syntaxFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if ([".js", ".mjs", ".cjs"].includes(extname(entry.name))) files.push(path);
    }
  };
  visit(resolve(projectRoot, root));
  return files;
}

const requestedFiles = process.argv.slice(2);
const files = requestedFiles.length > 0
  ? requestedFiles.map((file) => resolve(file)).sort()
  : [...roots.flatMap(syntaxFiles), ...["scripts/lark-im-worker.mjs"].map((file) => resolve(projectRoot, file)).filter(existsSync)].sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(`Syntax check failed: ${relative(projectRoot, file)}\n`);
    process.stderr.write(String(result.stderr || result.stdout || ""));
    process.exit(result.status || 1);
  }
}

process.stdout.write(`Syntax checked ${files.length} JavaScript files.\n`);
