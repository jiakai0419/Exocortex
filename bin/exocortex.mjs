#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CliExecutionError, CliUsageError, createCommandContext, writeCliError } from "../src/cli/context.mjs";
import { parseInvocation, renderHelp } from "../src/cli/registry.mjs";

export async function runCli(argv, overrides = {}) {
  const context = createCommandContext(overrides);
  // Parsing can fail before the route's default format is available.
  let format = argv.some((value, index) => value === "--format" && argv[index + 1] === "json")
    || argv[0] === "sync" && (!argv[1] || argv[1].startsWith("-")) ? "json" : "text";
  try {
    const invocation = parseInvocation(argv, { context });
    format = invocation.options.format;
    if (invocation.help) {
      context.stdout.write(renderHelp(invocation, { stream: context.stdout }));
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
    writeCliError(context, { format, code: usage ? "invalid_arguments" : "execution_failed", message,
      reason: error instanceof CliExecutionError ? error.reason : undefined, textPrefix: "Error: " });
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
