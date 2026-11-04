// @ts-check
import { readSqliteReadDiagnostic } from '../storage/sqlite/readonly-query.mjs';
import { copySqliteReadDiagnostic } from './sqlite-read-diagnostic.mjs';

const OPERATIONS=new Map([
  ['capture Lark source admission','source_admission'],['remote account binding','account_binding'],
  ['read resource scan','scan'],['read resource head','head'],['read newest resource page','newest_page'],
  ['read historical resource page','historical_page'],['read bounded resource source rows','source_rows'],
  ['reread resource scan','scan_refresh'],['read expired resource claims','expired_claims'],
  ['wrap expired resource claims','expired_claims_wrap'],['reread resource recovery cursor','recovery_refresh'],
  ['select resource work','work_selection'],
]);
const CATEGORIES=new Set([...OPERATIONS.values(),'unknown']);

/** Closed output only; this is diagnosis, never execution or request authority.
 * @param {any} value */
export function copyResourceReadDiagnostic(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  try {
    const fields=Object.getOwnPropertyDescriptors(value);
    if(Object.keys(fields).length!==2||!fields.operation||!Object.hasOwn(fields.operation,'value')
      ||!fields.diagnostic||!Object.hasOwn(fields.diagnostic,'value')||!CATEGORIES.has(fields.operation.value))return null;
    const diagnostic=copySqliteReadDiagnostic(fields.diagnostic.value);
    return diagnostic?Object.freeze({operation:fields.operation.value,diagnostic}):null;
  }catch{return null;}
}

/** @param {string} label @param {unknown} error */
export function resourceReadDiagnostic(label,error) {
  const diagnostic=readSqliteReadDiagnostic(error);
  return diagnostic?copyResourceReadDiagnostic({operation:OPERATIONS.get(label)||'unknown',diagnostic}):null;
}
