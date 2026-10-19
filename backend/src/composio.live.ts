import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openServiceDatabase } from "./db.js";
import { ComposioSources, PROVIDERS, SOURCE_LIMIT } from "./composio.js";
import { ApiError } from "./errors.js";
import type { ServiceState } from "./state.js";

const expected = [
  "salesforce:account",
  "salesforce:opportunity",
  "salesforce:note",
  "hubspot:company",
  "hubspot:deal",
  "hubspot:note",
  "gong:call",
  "gmail:thread",
  "outlook:thread",
  "notion:page",
  "googledrive:document",
  "one_drive:document",
  "microsoft_teams:chat",
];

type Case = {
  provider: (typeof PROVIDERS)[number];
  kind: string;
  query: string;
  recordId: string;
  expectedText: string;
};

function fixture(value: unknown): { accountId: bigint; cases: Case[] } {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const data = value as Record<string, unknown>;
  const accountId = data.accountId;
  assert.ok(typeof accountId === "string");
  assert.match(accountId, /^[1-9]\d*$/);
  assert.ok(Array.isArray(data.cases));
  const cases = data.cases as Case[];
  assert.deepEqual(
    cases.map((item) => `${item.provider}:${item.kind}`).sort(),
    [...expected].sort(),
    "provide exactly one fixture record for every supported kind",
  );
  for (const item of cases)
    for (const field of ["query", "recordId", "expectedText"] as const)
      assert.ok(
        typeof item[field] === "string" &&
          item[field].trim() &&
          item[field] !== "REPLACE",
        `${item.provider}:${item.kind} needs ${field}`,
      );
  return { accountId: BigInt(accountId), cases };
}

async function main() {
  const key = process.env.COMPOSIO_API_KEY;
  const path = process.env.SAVVY_CONNECTED_LIVE_FIXTURE;
  if (!key || !path) {
    process.stderr.write(
      "Set COMPOSIO_API_KEY and SAVVY_CONNECTED_LIVE_FIXTURE for a dedicated connected test account\n",
    );
    process.exitCode = 2;
    return;
  }
  const { accountId, cases } = fixture(JSON.parse(readFileSync(path, "utf8")));
  const db = openServiceDatabase(":memory:");
  try {
    db.prepare(
      "INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(?,'live-test','connected',0)",
    ).run(accountId);
    const state = { db, clock: () => BigInt(Date.now()) } as ServiceState;
    const service = new ComposioSources(state, key);
    const connections = await service.connections(accountId);
    const missing = connections.filter(
      (connection) => !connection.connected || !connection.accountId,
    );
    if (missing.length)
      process.stderr.write(
        `Disconnected: ${missing.map((connection) => `${connection.provider} (${connection.status})`).join(", ")}\n`,
      );
    assert.equal(missing.length, 0, "all test connections must be active");
    let passed = 0;
    for (const item of cases) {
      const label = `${item.provider}:${item.kind}`;
      try {
        const connection = connections.find(
          (entry) => entry.provider === item.provider,
        )!;
        const search = await service.search(accountId, {
          provider: item.provider,
          kind: item.kind,
          accountId: connection.accountId,
          query: item.query,
        });
        const preview = search.records.find(
          (record) => record.recordId === item.recordId,
        );
        assert.ok(preview, "fixture record missing from search results");
        const source = await service.fetch(accountId, preview);
        assert.equal(source.recordId, item.recordId);
        assert.ok(source.title && source.url.startsWith("https://"));
        assert.ok(source.modifiedAt, "missing modification time");
        assert.ok(source.content.includes(item.expectedText));
        assert.ok(Buffer.byteLength(source.content) <= SOURCE_LIMIT);
        passed++;
        process.stdout.write(`${label}: passed\n`);
      } catch (error) {
        const reason =
          error instanceof ApiError
            ? error.code
            : error instanceof Error
              ? error.name
              : "unknown error";
        process.stderr.write(`${label}: failed (${reason})\n`);
      }
    }
    assert.equal(
      passed,
      cases.length,
      `${passed}/${cases.length} cases passed`,
    );
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Live connected-source check stopped: ${error instanceof ApiError ? error.code : error instanceof Error ? error.name : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
