// Pure rendering for the checked-in catalog; no command execution or file writes.
const cell = (value) => String(value).replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
const code = (value) => `\`${cell(value)}\``;

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
