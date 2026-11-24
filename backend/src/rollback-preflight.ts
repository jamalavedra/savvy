import Database from "better-sqlite3";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  capability,
  manifestCapability,
  requiredFundingSchema,
} from "./capability.js";
import type { Db } from "./db.js";

/** The funding capability a release needs to serve this service database. */
export function requiredCapability(db: Db): number {
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
  return required;
}

export function rollbackPreflight(required: number, candidateManifest: string) {
  const available = existsSync(candidateManifest)
    ? manifestCapability(candidateManifest)
    : 0;
  if (available < required)
    throw new Error(
      `Candidate funding capability ${available} is below database requirement ${required}; release switch refused`,
    );
  return { requiredFundingSchema: required, availableFundingSchema: available };
}

function requiredFromFile(path: string) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Expected an existing regular service database");
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.defaultSafeIntegers(true);
    return requiredCapability(db);
  } finally {
    db.close();
  }
}

async function requiredFromObject(origin: string) {
  const token = process.env.SAVVY_ADMIN_TOKEN;
  if (!token) throw new Error("Set SAVVY_ADMIN_TOKEN to read the object");
  const response = await fetch(new URL("/__admin/manifest", origin), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok)
    throw new Error(
      `The object's manifest answered ${response.status}: ${await response.text()}`,
    );
  const body = (await response.json()) as { requiredFundingSchema?: unknown };
  if (!Number.isSafeInteger(body.requiredFundingSchema))
    throw new Error("The object's manifest has no funding requirement");
  return body.requiredFundingSchema as number;
}

if (
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
) {
  try {
    const [source, target, flag, candidate, ...extra] = process.argv.slice(2);
    if (
      !["--db", "--url"].includes(source ?? "") ||
      !target ||
      flag !== "--candidate" ||
      !candidate ||
      extra.length
    )
      throw new Error(
        "Usage: rollback-preflight (--db <existing-service.sqlite> | --url <backend-origin>) --candidate <built-service-capabilities.json>",
      );
    const required =
      source === "--db"
        ? requiredFromFile(target)
        : await requiredFromObject(target);
    console.log(JSON.stringify(rollbackPreflight(required, candidate)));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Funding preflight failed",
    );
    process.exitCode = 1;
  }
}
