#!/usr/bin/env node
// Internal long-running process entrypoint. Public commands live in bin/exocortex.mjs.
import { main } from "./worker.mjs";
try { process.exitCode = main(); }
catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
