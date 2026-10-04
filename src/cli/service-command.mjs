// @ts-check

import { ServiceOperationError, install, start, stop, restart, uninstall } from "../runtime/service/launchd.mjs";
import { validateWorkerOptions } from "../runtime/worker/options.mjs";
import { CliExecutionError, CliUsageError } from "./context.mjs";

/** Registry parses flags and resolves paths; lifecycle modules own effects.
 * @param {Record<string, any>} options @param {Record<string, any>} context */
export async function runServiceCommand(options, context) {
  const deps = { root: context.root, cwd: context.cwd, env: context.env, ...context.serviceDeps };
  const actions = { start, stop, restart, uninstall };
  const action = options.action;
  if (action === "install") {
    try { validateWorkerOptions(options); }
    catch (error) { throw new CliUsageError(error instanceof Error ? error.message : "invalid worker configuration"); }
  }
  let result;
  try {
    result = action === "install" ? install(/** @type {import("../runtime/worker/options.mjs").WorkerSettings} */ (options), deps) : actions[action]?.(deps);
  } catch (error) {
    if (error instanceof ServiceOperationError) throw new CliExecutionError(error.message);
    throw error;
  }
  if (!result) throw new CliUsageError("unknown service action");
  if (options.format === "json") context.stdout.write(`${JSON.stringify(result)}\n`);
  else context.stdout.write(`Service ${result.status.replaceAll("_", " ")}\n`);
  return 0;
}
