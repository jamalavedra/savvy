import Database from "better-sqlite3";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  capability,
  manifestCapability,
  requiredFundingSchema,
} from "./capability.js";
import type { Db } from "./db.js";

export function rollbackPreflight(db: Db, candidateManifest: string) {
  const hasTable = (name: string) =>
    !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
  let required = hasTable("service_capabilities")
    ? requiredFundingSchema(db)
    : 0;
  if (
    (hasTable("service_capabilities") &&
      capability(db, "team_purchase_enabled") === "1") ||
    ["organization_checkouts", "organization_subscriptions"].some(
      (name) =>
        hasTable(name) && !!db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get(),
    )
  )
    required = Math.max(2, required);
  const available = existsSync(candidateManifest)
    ? manifestCapability(candidateManifest)
    : 0;
  if (available < required)
    throw new Error(
      `Candidate funding capability ${available} is below database requirement ${required}; release switch refused`,
    );
  return { requiredFundingSchema: required, availableFundingSchema: available };
}

if (
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
) {
  let db: Db | undefined;
  try {
    const args = process.argv.slice(2);
    if (
      args.length !== 4 ||
      args[0] !== "--db" ||
      !args[1] ||
      args[2] !== "--candidate" ||
      !args[3]
    )
      throw new Error(
        "Usage: rollback-preflight --db <existing-service.sqlite> --candidate <built-service-capabilities.json>",
      );
    const info = lstatSync(args[1]);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Expected an existing regular service database");
    db = new Database(args[1], { readonly: true, fileMustExist: true });
    db.defaultSafeIntegers(true);
    console.log(JSON.stringify(rollbackPreflight(db, args[3])));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Funding preflight failed",
    );
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
