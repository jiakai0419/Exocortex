import { CliUsageError, createCommandContext } from "./context.mjs";

function optionValue(spec, value) {
  if (spec.type === "path" && !value) throw new CliUsageError(`${spec.flag} requires a non-empty path`);
  if (spec.type === "integer") {
    const min = spec.min ?? 1;
    if (!(min === 0 ? /^\d+$/ : /^[1-9]\d*$/).test(value)) throw new CliUsageError(`${spec.flag} must be ${min === 0 ? "a non-negative" : "a positive"} integer`);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || spec.max !== undefined && number > spec.max) {
      throw new CliUsageError(`${spec.flag} is outside its supported range`);
    }
    return number;
  }
  if (spec.choices && !spec.choices.includes(value)) throw new CliUsageError(`${spec.flag} must be ${spec.choices.join(", ")}`);
  return value;
}

/** Primitive parsing is shared; domain window, identity and effect rules are not a DSL. */
export function parseOptions(argv, specs, { context = createCommandContext(), allowAll = false, resolvePaths = true } = {}) {
  /** @type {Record<string, any>} */
  const options = {};
  const provided = new Set();
  let help = false;
  let all = false;
  for (const spec of specs) {
    if (spec.default !== undefined) options[spec.key] = spec.default;
    else if (spec.repeat) options[spec.key] = [];
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") { help = true; continue; }
    if (flag === "--all" && allowAll) { all = true; continue; }
    const spec = specs.find((entry) => entry.flag === flag);
    if (!spec) throw new CliUsageError("Unknown option or unexpected command argument");
    if (provided.has(flag) && !spec.repeat) throw new CliUsageError(`${flag} may be specified only once`);
    provided.add(flag);
    if (spec.type === "boolean") { options[spec.key] = true; continue; }
    const value = argv[++index];
    if (value === undefined || value === "-h" || value.startsWith("--")) throw new CliUsageError(`${flag} requires a value`);
    const parsed = optionValue(spec, value);
    if (spec.repeat) options[spec.key].push(parsed);
    else options[spec.key] = parsed;
  }
  if (!help) for (const spec of specs) {
    if (spec.required && !provided.has(spec.flag)) throw new CliUsageError(`${spec.flag} is required`);
  }
  for (const spec of specs) {
    if (resolvePaths && spec.type === "path" && options[spec.key] !== undefined) {
      options[spec.key] = context.resolvePath(options[spec.key], { explicit: provided.has(spec.flag) });
    }
  }
  return { options, provided, help, all };
}
