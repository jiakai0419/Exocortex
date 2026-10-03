#!/usr/bin/env node
// @ts-check

import { pathToFileURL } from "node:url";
import { runLarkImReplayCli } from "../src/cli/lark-im-replay-command.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = runLarkImReplayCli(process.argv.slice(2));
  if (exitCode !== 0) process.exit(exitCode);
}
