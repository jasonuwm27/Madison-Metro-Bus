import postgres from "postgres";
import type { Config } from "../config.js";

export type Sql = postgres.Sql;

/**
 * Postgres connection.
 *
 * `prepare: false` is required when DATABASE_URL points at Supabase's
 * transaction pooler (port 6543): Supavisor hands a different backend to each
 * checkout, so a prepared statement created on one is missing on the next. The
 * session pooler and direct connections keep prepared statements, which are
 * worth having for a worker running the same upsert every 30 seconds.
 *
 * The pool is small by design. This is one process issuing batched writes, and
 * Supabase's free tier has a low connection ceiling that is easy to exhaust.
 */
export function createSql(cfg: Config): Sql {
  return postgres(cfg.databaseUrl, {
    max: cfg.pgPoolMax,
    prepare: cfg.pgPrepare,
    idle_timeout: 60,
    connect_timeout: 15,
    // Keep the worker resilient to transient connection loss. postgres.js
    // reconnects on its own; this only bounds how long a single query waits.
    max_lifetime: 60 * 30,
    onnotice: () => {
      // Postgres emits a NOTICE for every `create table if not exists` that
      // finds an existing table. Silenced so migrations do not drown the log.
    },
  });
}
