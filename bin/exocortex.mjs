#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CliExecutionError, CliUsageError, createCommandContext } from "../src/cli/context.mjs";
import { parseInvocation, renderHelp } from "../src/cli/registry.mjs";

export async function runCli(argv, overrides = {}) {
  const context = createCommandContext(overrides);
  try {
    const invocation = parseInvocation(argv, { context });
    if (invocation.help) {
      context.stdout.write(renderHelp(invocation));
      return 0;
    }
    if (!invocation.definition) throw new CliUsageError("An executable command is required");
    const group = invocation.definition.group;
    const module = overrides.loadCommand ? await overrides.loadCommand(group)
      : await import(`../src/cli/${group}-command.mjs`);
    const name = `run${group[0].toUpperCase()}${group.slice(1)}Command`;
    const code = await module[name](invocation.options, {
      ...context, route: invocation.route, provided: invocation.provided,
    });
    if (![0, 1, 2].includes(code)) throw new Error("Invalid command exit result");
    return code;
  } catch (error) {
    const usage = error instanceof CliUsageError;
    const message = usage || error instanceof CliExecutionError ? error.message : "Unable to complete command; check its required dependencies and local evidence.";
    if (argv.some((value, index) => value === "--format" && argv[index + 1] === "json")) {
      context.stdout.write(`${JSON.stringify({ schema_version: 1, ok: false, error: { code: usage ? "invalid_arguments" : "execution_failed", message,
        ...(error instanceof CliExecutionError && error.reason ? { reason: error.reason } : {}) } })}\n`);
    } else context.stderr.write(`Error: ${message}\n`);
    return 1;
  }
}

function isMainModule() {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
