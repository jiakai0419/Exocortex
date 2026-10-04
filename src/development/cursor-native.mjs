import { createHash } from "node:crypto";

const hash = (value) => typeof value === "string" && value ? createHash("sha256").update(value).digest("hex").slice(0, 16) : null;
const items = (record) => Array.isArray(record.json?.data?.items) ? record.json.data.items : [];

/** Native probes keep response ordering and structural differences without
 * production normalization, deduplication, paging loops or retries. */
export function nativeCursorCommand(run, observations, id, args, options = {}) {
  const operation = args[1];
  if (!["+messages-search", "+chat-messages-list"].includes(operation)) return run(id, args, options);
  const value = (flag) => args[args.indexOf(flag) + 1];
  const startMs = Date.parse(value("--start")); const endMs = Date.parse(value("--end"));
  const page = args.includes("--page-token") ? { page_token: value("--page-token") } : {};
  /** @param {any} [body] */
  const request = (suffix, method, path, params, body = undefined) => {
    const argv = ["api", method, path, "--as", "user", "--params", JSON.stringify(params), "--format", "json"];
    if (body !== undefined) argv.push("--data", JSON.stringify(body));
    const record = run(`${id}${suffix}`, argv, { redactedFlags: ["--params", "--data"] });
    const rows = items(record);
    observations.push({ id: record.id, command: record.command, ok: record.ok,
      exit_code: record.exit_code, failure_kind: record.failure_kind, stderr: record.stderr,
      json_parse_failed: record.json_parse_failed, stdout_excerpt: record.stdout_excerpt,
      request_page_size: params.page_size ?? null,
      request_time_range: body?.filter?.time_range || (params.start_time ? { start_time: params.start_time, end_time: params.end_time } : null),
      requested_message_hashes: params.message_ids?.map(hash) ?? null,
      response_code: record.json?.code ?? null, response_success: record.json?.success ?? null,
      root_keys: Object.keys(record.json || {}).sort(), data_keys: Object.keys(record.json?.data || {}).sort(),
      has_more: record.json?.data?.has_more ?? null, page_token_present: Boolean(record.json?.data?.page_token),
      items: rows.map((row) => ({ keys: Object.keys(row || {}).sort(),
        message_id_hash: hash(row?.meta_data?.message_id || row?.message_id),
        create_time: row?.create_time ?? null })),
    });
    return record;
  };
  if (operation === "+chat-messages-list") {
    return request("", "GET", "/open-apis/im/v1/messages", {
      container_id_type: "chat", container_id: value("--chat-id"), only_thread_root_messages: false,
      sort_type: "ByCreateTimeAsc", page_size: Math.min(Number(value("--page-size")), 50),
      card_msg_content_type: "raw_card_content", start_time: String(Math.floor(startMs / 1000)),
      end_time: String(Math.ceil(endMs / 1000)), ...page,
    });
  }
  const search = request("", "POST", "/open-apis/im/v1/messages/search", {
    page_size: Math.min(Number(value("--page-size")), 30), ...page,
  }, { query: "", filter: { from_ids: [value("--sender")], time_range: {
    start_time: new Date(Math.floor(startMs / 1000) * 1000).toISOString().replace(".000Z", "Z"),
    end_time: new Date(Math.ceil(endMs / 1000) * 1000).toISOString().replace(".000Z", "Z"),
  } } });
  const ids = items(search).map((row) => row?.meta_data?.message_id);
  if (!search.ok || !ids.length || ids.length > 30 || ids.some((id) => typeof id !== "string" || !id)) return search;
  const detail = request("_mget", "GET", "/open-apis/im/v1/messages/mget", {
    message_ids: ids, card_msg_content_type: "raw_card_content",
  });
  // The joined view follows search order; separate observations preserve the
  // original search and mget order, duplicates, omissions and extra items.
  const messages = ids.flatMap((id) => items(detail).filter((row) => row?.message_id === id));
  return { ...search, ok: search.ok && detail.ok, json: {
    ...search.json, data: { ...search.json?.data, items: messages },
  } };
}
