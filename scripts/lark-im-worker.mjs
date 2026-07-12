#!/usr/bin/env node

// @ts-check

import { pathToFileURL } from "node:url";
import {
  main,
  parseArgs,
  parsePositiveInt,
  runCycle,
  runStep,
  runWorker,
  rotateLogIfNeeded,
  sleepSeconds,
  usage,
  writeLog,
} from "../src/cli/lark-im-worker-command.mjs";

export {
  main,
  parseArgs,
  parsePositiveInt,
  runCycle,
  runStep,
  runWorker,
  rotateLogIfNeeded,
  sleepSeconds,
  usage,
  writeLog,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const exitCode = main();
    if (exitCode !== 0) process.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
