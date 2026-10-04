// Test harness for the shared parser and the public sync adapter. No legacy entrypoint.
import { parseOptions } from "../../src/cli/parse-options.mjs";
import { renderHelp } from "../../src/cli/registry.mjs";
import { SYNC_OPTION_SPECS } from "../../src/adapters/lark-im/sync-options.mjs";
import { executeLarkImSync, normalizeSyncOptions } from "../../src/adapters/lark-im/sync-command.mjs";
import { runSyncCommand } from "../../src/cli/sync-command.mjs";

export { executeLarkImSync };
export function parseArgs(argv, now = Date.now) {
  const { options, provided } = parseOptions(argv, SYNC_OPTION_SPECS, { context: { resolvePath: (path) => path } });
  return normalizeSyncOptions(options, { provided, now });
}
export function runLarkImSyncCli(argv, io = {}) {
  const nowMs = (io.now || Date.now)();
  const context = { root: "/synthetic-install", cwd: "/synthetic-cwd", env: {}, now: () => nowMs,
    stdout: io.stdout || process.stdout, stderr: io.stderr || process.stderr,
    resolvePath: (path) => path, ...io };
  try {
    const parsed = parseOptions(argv, SYNC_OPTION_SPECS, { context });
    if (parsed.help) { context.stdout.write(renderHelp({ route: "sync" })); return 0; }
    return runSyncCommand(parsed.options, { ...context, provided: parsed.provided });
  } catch (error) { context.stderr.write(`${error.message}\n`); return 1; }
}
