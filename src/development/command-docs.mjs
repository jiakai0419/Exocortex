// Pure rendering for the checked-in catalog; no command execution or file writes.
const cell = (value) => String(value).replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
const code = (value) => `\`${cell(value)}\``;

export function maintenanceEffectDocumentation(catalog) {
  const commands = catalog.commands.filter(({ group }) => group === "maintenance");
  const writers = commands.filter(({ effects }) => effects.includes("database-write"));
  const rows = commands.map((entry) => {
    const apply = entry.options.some(({ flag }) => flag === "--apply")
      ? entry.modes.find(({ when }) => when === "--apply").effects.join(", ") : "不支持";
    const other = entry.modes.filter(({ when, effects }) => when !== "--apply" && effects?.length)
      .map(({ when, effects }) => `${code(when)}：${cell(effects.join(", "))}`).join("；") || "—";
    return `| ${code(entry.path.join(" "))} | ${cell(entry.effects.join(", "))} | ${cell(apply)} | ${other} |`;
  });
  return [
    `默认可能写数据库：${writers.map(({ path }) => code(path.join(" "))).join("、")}。\`--apply\` 不是维护命令的统一写入开关。`,
    "", "下表由 registry 生成；默认效果表示可能产生的副作用，不保证每次调用都实际写入。预览也可能读取远端或写私有文件，不能当作离线或无副作用操作。",
    "", "| 命令 | 默认效果 | `--apply` 附加效果 | 其他显式效果 |", "| --- | --- | --- | --- |", ...rows,
  ].join("\n");
}

export function commandDocumentation(catalog) {
  const routes = ["| 命令 | 能力 | 默认效果 | 默认输出级别 |", "| --- | --- | --- | --- |"];
  const options = [];
  for (const entry of catalog.commands) {
    const name = entry.path.join(" ");
    routes.push(`| ${code(name)} | ${cell(entry.summary)} | ${cell(entry.effects.join(", "))} | ${code(entry.privacy)} |`);
    options.push(`### ${name}`, "", entry.summary, "",
      `默认效果：${code(entry.effects.join(", "))}；输出：${code(entry.privacy)}。`, "");
    if (entry.modes.length) {
      options.push("| 显式模式 | 附加效果或输出级别 |", "| --- | --- |");
      for (const mode of entry.modes) options.push(`| ${code(mode.when)} | ${cell(mode.effects?.join(", ") || mode.privacy)} |`);
      options.push("");
    }
    options.push("| 参数 | 类型/取值 | 默认 | 约束 | 说明 |", "| --- | --- | --- | --- | --- |");
    for (const spec of entry.options) {
      const constraints = [spec.required ? "必填" : "", spec.repeat ? "可重复" : "",
        spec.min === undefined ? "" : `≥ ${spec.min}`, spec.max === undefined ? "" : `≤ ${spec.max}`].filter(Boolean).join("；") || "—";
      const value = spec.default === undefined ? "—" : code(spec.default === "" ? "空字符串" : spec.default);
      options.push(`| ${code(spec.flag)} | ${cell(spec.choices?.join("/") || spec.type)} | ${value} | ${constraints} | ${cell(spec.description)} |`);
    }
    options.push("");
  }
  return { routes: routes.join("\n"), options: options.join("\n").trimEnd() };
}
