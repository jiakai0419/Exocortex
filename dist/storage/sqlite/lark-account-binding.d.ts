declare const INITIAL_ACCOUNT_KIND = "lark_im_initial_account/v1";
/** Reserve a genuinely empty source before any run can outlive its command.
 * Pending association constrains retries but does not attest successful work. */
declare function reserveInitialLarkAccount(dbPath: string, accountKey: string, now: string): void;
/** Compose only with an actual list/discovery commit, after its run fence.
 * Rollback includes this confirmation; errors and skipped work never call it. */
declare function confirmInitialLarkAccountSql(now: string): string;
export { INITIAL_ACCOUNT_KIND, reserveInitialLarkAccount, confirmInitialLarkAccountSql };
