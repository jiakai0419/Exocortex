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
  sleepSeconds,
  usage,
  writeLog,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
