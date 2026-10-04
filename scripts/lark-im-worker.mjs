#!/usr/bin/env node
// Temporary migration bridge W: remove after the installed LaunchAgent uses the
// internal runtime entrypoint. Preserve the old cwd defaults and JSONL protocol.
import { main } from "../src/runtime/worker/worker.mjs";
try { process.exitCode = main(process.argv.slice(2), { legacyPaths: true }); }
catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
