declare function initializeDatabase(path: string, options?: {
    migrationsDir?: string;
}): {
    ok: boolean;
    db_path: string;
    applied: string[];
};
export { initializeDatabase };
