export type LarkWriteAdmission = {
    sourceConfigJson: string;
    selfOpenId: string | null;
    accountKey: string | null;
    sentActor: string | null;
    requireVerified: boolean;
    sidecarVerified: boolean;
    scopes: Array<{
        id: string;
        source_id: string;
        enabled: number;
        config_json: string;
    }>;
};
declare function larkScopeAdmissionSql(scope: LarkWriteAdmission["scopes"][number] | undefined): string;
/** Database facts only. Files and remote identity are checked by the request
 * owner under its shared lease; this predicate never claims to fence files. */
declare function larkWriteAdmissionSql(value: LarkWriteAdmission, table?: string): string;
export { larkWriteAdmissionSql, larkScopeAdmissionSql };
