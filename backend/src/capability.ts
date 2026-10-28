import { readFileSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { openPrivateDatabase, type Db } from "./db.js";

export function manifestCapability(path: string | URL): number {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    value === null ||
    typeof value !== "object" ||
    !("funding_schema" in value) ||
    !Number.isSafeInteger(value.funding_schema) ||
    Number(value.funding_schema) < 0
  )
    throw new Error("Invalid funding capability manifest");
  return Number(value.funding_schema);
}
export const FUNDING_SCHEMA = manifestCapability(
  new URL("./service-capabilities.json", import.meta.url),
);

export function capability(db: Db, key: string): string | undefined {
  return db
    .prepare<[string], { value: string }>(
      "SELECT value FROM service_capabilities WHERE key=?",
    )
    .get(key)?.value;
}
export function requiredFundingSchema(db: Db): number {
  const value = capability(db, "required_funding_schema");
  if (value === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("Invalid database funding requirement");
  return Number(value);
}
export function assertFundingCapability(db: Db, available = FUNDING_SCHEMA) {
  if (!Number.isSafeInteger(available) || available < requiredFundingSchema(db))
    throw new Error(
      "Backend cannot enforce this database's funding requirements",
    );
}
export function teamPurchasesEnabled(db: Db) {
  return capability(db, "team_purchase_enabled") === "1";
}
export function validTeamPortalConfiguration(value: unknown, id: string) {
  if (!value || typeof value !== "object") return false;
  const portal = value as Record<string, unknown>;
  const features = portal.features as
    Record<string, { enabled?: unknown } | undefined> | undefined;
  return (
    portal.id === id &&
    portal.active === true &&
    features?.subscription_update?.enabled === false &&
    features?.subscription_cancel?.enabled === true
  );
}
export async function configureTeamPortal(
  db: Db,
  id: string,
  retrieve: (id: string) => Promise<unknown>,
  now: bigint,
) {
  if (!/^bpc_[A-Za-z0-9]+$/.test(id))
    throw new Error("Invalid team portal configuration ID");
  if (!validTeamPortalConfiguration(await retrieve(id), id))
    throw new Error(
      "Team portal must allow cancellation and disable subscription updates",
    );
  db.transaction(() =>
    setCapability(db, "organization_portal_configuration_id", id, now),
  ).immediate();
}
export function setCapability(db: Db, key: string, value: string, now: bigint) {
  if (!db.inTransaction)
    throw new Error("Capability changes require a transaction");
  db.prepare(
    "INSERT INTO service_capabilities(key,value,set_at_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,set_at_ms=excluded.set_at_ms",
  ).run(key, value, now);
}
export function activateTeamPurchases(
  db: Db,
  checkpoint: string,
  checkpointCapability: number,
  now: bigint,
  available = FUNDING_SCHEMA,
) {
  if (
    available < 2 ||
    checkpointCapability < 2 ||
    !/^[0-9a-f]{40}$/.test(checkpoint)
  )
    throw new Error(
      "Activation requires a complete funding-aware release and checkpoint",
    );
  db.transaction(() => {
    assertFundingCapability(db, available);
    if (
      !/^bpc_[A-Za-z0-9]+$/.test(
        capability(db, "organization_portal_configuration_id") ?? "",
      )
    )
      throw new Error(
        "Configure and validate the team billing portal before activation",
      );
    const previous = capability(db, "funding_checkpoint_commit");
    if (previous !== undefined && previous !== checkpoint)
      throw new Error("The recorded paid-seat checkpoint is immutable");
    setCapability(
      db,
      "required_funding_schema",
      String(Math.max(2, requiredFundingSchema(db))),
      now,
    );
    setCapability(db, "funding_checkpoint_commit", checkpoint, now);
    setCapability(db, "team_purchase_enabled", "1", now);
  }).immediate();
}
export function disableTeamPurchases(db: Db, now: bigint) {
  db.transaction(() =>
    setCapability(db, "team_purchase_enabled", "0", now),
  ).immediate();
}

if (
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
) {
  let db: Db | undefined;
  try {
    const [command, ...args] = process.argv.slice(2);
    const allowed =
      command === "configure-team-portal"
        ? ["--db", "--configuration"]
        : command === "activate-team-purchases"
          ? ["--db", "--checkpoint-commit", "--checkpoint-manifest"]
          : ["--db"];
    if (
      ![
        "show",
        "configure-team-portal",
        "activate-team-purchases",
        "disable-team-purchases",
      ].includes(command) ||
      args.length !== allowed.length * 2
    )
      throw new Error(
        "Usage: capability <show|disable-team-purchases|configure-team-portal|activate-team-purchases> --db <service.sqlite> [--configuration <bpc_id> | --checkpoint-commit <sha> --checkpoint-manifest <path>]. Stop the service first.",
      );
    const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      if (!allowed.includes(args[i]) || flags.has(args[i]) || !args[i + 1])
        throw new Error("Invalid capability arguments");
      flags.set(args[i], args[i + 1]);
    }
    // This command opens an existing ledger only; a typo must not create a new one.
    if (!statSync(flags.get("--db")!).isFile())
      throw new Error("Expected an existing service database file");
    db = openPrivateDatabase(flags.get("--db")!);
    db.defaultSafeIntegers(true);
    const now = BigInt(Date.now());
    if (command === "configure-team-portal") {
      const key = process.env.SAVVY_STRIPE_SECRET_KEY;
      if (!key) throw new Error("SAVVY_STRIPE_SECRET_KEY is required");
      await configureTeamPortal(
        db,
        flags.get("--configuration")!,
        async (id) => {
          const response = await fetch(
            `https://api.stripe.com/v1/billing_portal/configurations/${id}`,
            {
              headers: {
                Authorization: `Bearer ${key}`,
                "Stripe-Version": "2025-06-30.basil",
              },
              redirect: "error",
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error("Unable to retrieve team portal configuration");
          }
          return response.json();
        },
        now,
      );
    }
    if (command === "activate-team-purchases")
      activateTeamPurchases(
        db,
        flags.get("--checkpoint-commit")!,
        manifestCapability(flags.get("--checkpoint-manifest")!),
        now,
      );
    if (command === "disable-team-purchases") disableTeamPurchases(db, now);
    console.log(
      JSON.stringify({
        requiredFundingSchema: requiredFundingSchema(db),
        availableFundingSchema: FUNDING_SCHEMA,
        teamPurchaseEnabled: teamPurchasesEnabled(db),
        checkpointCommit: capability(db, "funding_checkpoint_commit") ?? null,
      }),
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Capability command failed",
    );
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
