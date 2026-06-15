import type { Writable } from "node:stream";
import { styleText } from "node:util";
type PaintOptions = {
    stream?: Writable;
};
type KvOptions = {
    width?: number;
};
type TableColumn<Row extends Record<string, any> = Record<string, any>> = {
    header: string;
    key: string;
    render?: (row: Row) => unknown;
};
type ListOptions = {
    empty?: string;
};
type StyleFormat = Parameters<typeof styleText>[0];
declare function paint(format: StyleFormat, text: unknown, options?: PaintOptions): string;
declare function plain(value: unknown): string;
declare function visibleLength(value: unknown): number;
declare function padRight(value: unknown, width: number): string;
declare function title(text: unknown): string;
declare function subtitle(text: unknown): string;
declare function section(text: unknown): string;
declare function command(text: unknown): string;
declare function key(text: unknown): string;
declare function value(text: unknown): string;
declare function hint(label: unknown, text: unknown): string;
declare function statusBadge(status: unknown): string;
declare function kv(rows: Array<[unknown, unknown] | null | undefined>, options?: KvOptions): string;
declare function table<Row extends Record<string, any>>(rows: Row[], columns: Array<TableColumn<Row>>): string;
declare function list(items: unknown[] | null | undefined, options?: ListOptions): string;
declare function block(lines: unknown[]): string;
declare function compact(value: unknown, limit?: number): string;
declare function json(value: unknown): string;
declare function renderError(error: unknown): string;
export { block, command, compact, hint, json, key, kv, list, padRight, paint, plain, renderError, section, statusBadge, subtitle, table, title, value, visibleLength, };
