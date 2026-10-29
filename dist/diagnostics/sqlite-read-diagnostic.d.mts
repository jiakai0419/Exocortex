/** Public diagnostics have a closed schema; never spread an error or child result.
 * @param {unknown} value @returns {Readonly<Record<string, any>> | null} */
export function copySqliteReadDiagnostic(value: unknown): Readonly<Record<string, any>> | null;
export function sqliteReadStage(label: any): "schema_query" | "snapshot_query" | "sqlite_query";
/** Evidence from one observed subprocess, without its raw diagnostic content.
 * @param {{stage:string,kind:string,result?:any,elapsedMs?:number|null,timeoutMs?:number|null,maxBufferBytes?:number|null}} input */
export function sqliteReadDiagnostic(input: {
    stage: string;
    kind: string;
    result?: any;
    elapsedMs?: number | null;
    timeoutMs?: number | null;
    maxBufferBytes?: number | null;
}): Readonly<Record<string, any>> | null;
export function renderSqliteReadDiagnostic(value: any): string;
