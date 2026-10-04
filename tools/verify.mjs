#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verify } from "../src/development/verify.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  process.stdout.write("Usage: node tools/verify.mjs [--generated-only]\nFull verification builds once, typechecks, checks syntax, runs all tests (concurrency 4), then compares clean generated files.\n");
} else if (args.length > 1 || (args.length === 1 && args[0] !== "--generated-only")) {
  process.stderr.write("Usage: node tools/verify.mjs [--generated-only]\n");
  process.exitCode = 1;
} else {
  process.exitCode = verify(resolve(dirname(fileURLToPath(import.meta.url)), ".."), {
    generatedOnly: args[0] === "--generated-only",
  });
}
