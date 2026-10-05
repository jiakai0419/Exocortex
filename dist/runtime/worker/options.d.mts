export function validateWorkerOptions(opts: any): void;
/** @param {WorkerSettings} opts */
export function workerProgramArguments(opts: WorkerSettings): string[];
/** Defaults are root-relative; explicit paths are cwd-relative. */
export function resolveWorkerPaths(opts: any, { root, cwd, provided }?: {
    root?: string | undefined;
    cwd?: string | undefined;
    provided?: Set<any> | undefined;
}): any;
/** Parse only persistent arguments; process lifetime flags never enter a service plist.
 * @param {string[]} argv
 * @param {{root?:string,cwd?:string,resolvePaths?:boolean}} [context]
 */
export function parseWorkerProgramArguments(argv: string[], context?: {
    root?: string;
    cwd?: string;
    resolvePaths?: boolean;
}): any;
/** @typedef {typeof defaults} WorkerSettings */
export const WORKER_DEFAULTS: Readonly<{
    db: string;
    intervalSeconds: number;
    receivedScopesPerCycle: number;
    hotReceivedScopesPerCycle: number;
    discoveryPagesPerCycle: number;
    hotDiscoveryPagesPerCycle: number;
    maxChatPages: number;
    reconcileIntervalHours: number;
    chatTypes: string;
    logDir: string;
    stepTimeoutSeconds: number;
    logMaxBytes: number;
    logKeepFiles: number;
    retentionEveryCycles: number;
    adaptiveFair: boolean;
    adaptiveFairMin: number;
    adaptiveFairMax: number;
    adaptiveTargetCycleSeconds: number;
    remoteSampleIntervalSeconds: number;
}>;
/**
 * @typedef {{flag:string,key:string,type:"path"|"string"|"boolean"|"integer"|"enum",default?:any,choices?:string[],min?:number,max?:number,repeat?:boolean,required?:boolean,description:string}} OptionSpec
 */
/** @type {ReadonlyArray<OptionSpec>} */
export const WORKER_OPTION_SPECS: ReadonlyArray<OptionSpec>;
export type WorkerSettings = typeof defaults;
export type OptionSpec = {
    flag: string;
    key: string;
    type: "path" | "string" | "boolean" | "integer" | "enum";
    default?: any;
    choices?: string[];
    min?: number;
    max?: number;
    repeat?: boolean;
    required?: boolean;
    description: string;
};
declare namespace defaults {
    let db: string;
    let intervalSeconds: number;
    let receivedScopesPerCycle: number;
    let hotReceivedScopesPerCycle: number;
    let discoveryPagesPerCycle: number;
    let hotDiscoveryPagesPerCycle: number;
    let maxChatPages: number;
    let reconcileIntervalHours: number;
    let chatTypes: string;
    let logDir: string;
    let stepTimeoutSeconds: number;
    let logMaxBytes: number;
    let logKeepFiles: number;
    let retentionEveryCycles: number;
    let adaptiveFair: boolean;
    let adaptiveFairMin: number;
    let adaptiveFairMax: number;
    let adaptiveTargetCycleSeconds: number;
    let remoteSampleIntervalSeconds: number;
}
export {};
