import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logger.js";
import type { Sql } from "./client.js";

/**
 * Applies sql/*.sql in filename order.
 *
 * Every statement in those files is written to be idempotent (`create table if
 * not exists`, `create or replace function`), so this runs unconditionally at
 * worker startup rather than tracking applied versions. For a schema this size
 * that is simpler and harder to get wrong than a migration ledger -- and it
 * means a fresh database needs no separate setup step before collecting.
 */
export async function runMigrations(sql: Sql, logger: Logger): Promise<void> {
  const dir = fileURLToPath(new URL("../../sql", import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8");
    // Simple protocol: sends the whole file as one query string, which is what
    // allows multiple statements and dollar-quoted function bodies.
    await sql.unsafe(text).simple();
    logger.info({ migration: file }, "migration applied");
  }
}
