import pino from "pino";
import type { Config } from "./config.js";

/**
 * Structured logging.
 *
 * JSON by default. The worker's job is to run unattended for weeks, so the
 * logs are the only record of what happened at 3am; they need to be greppable
 * and machine-parseable, not pretty. `LOG_FORMAT=pretty` is for local dev only
 * and pulls in pino-pretty lazily so production never loads it.
 */
export function createLogger(cfg: Config): pino.Logger {
  if (cfg.log.format === "pretty") {
    return pino({
      level: cfg.log.level,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
      },
    });
  }
  return pino({
    level: cfg.log.level,
    base: { service: "gtfsrt-collector" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = pino.Logger;
