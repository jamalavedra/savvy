import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { migrateService, openServiceDatabase } from "./db.js";
import { ComposioSources, SOURCE_LIMIT } from "./composio.js";
import { ApiError } from "./errors.js";
import type { ServiceState } from "./state.js";

const ISSUER = "https://api.savvy.test";
const USER_ONE = `savvy:${createHash("sha256").update(ISSUER).digest("hex")}:1`;

function fixture(t: TestContext, issuer = ISSUER) {
  const db = openServiceDatabase(":memory:");
  t.after(() => db.close());
  db.prepare(
    "INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(1,'test','one',0),(2,'test','two',0)",
  ).run();
  const state = { config: { issuer }, db, clock: () => 1_000n } as ServiceState;
  const service = new ComposioSources(state, "synthetic");
  const calls: Array<{ user: string; cursor?: string }> = [];
  const proxyCalls: Array<{
    endpoint: string;
    parameters?: unknown;
    body?: unknown;
  }> = [];
  const revoked: string[] = [];
  const deleted: string[] = [];
  const createdUsers: string[] = [];
  const reusedSessions: string[] = [];
  let created: unknown;
  let scope: string | undefined;
  let toolkit = "hubspot";
  let response: unknown = {
    results: [
      {
        id: "company-1",
        properties: { name: "Acme", description: "Full description" },
        updatedAt: "2026-10-01",
      },
    ],
    paging: { next: { after: "next-page" } },
  };
  const session = {
    sessionId: "session-1",
    authorize: async () => ({
      redirectUrl: "https://connect.composio.dev/link",
    }),
    proxyExecute: async (args: {
      endpoint: string;
      parameters?: unknown;
      body?: unknown;
    }) => {
      proxyCalls.push(args);
      return {
        status: 200,
        data:
          typeof response === "function"
            ? (response as (args: { endpoint: string }) => unknown)(args)
            : response,
      };
    },
    execute: async () => ({ data: response, error: null }),
  };
  const client = {
    sessions: {
      create: async (user: string, config: unknown) => {
        createdUsers.push(user);
        created = config;
        return session;
      },
      use: async (id?: string) => {
        if (id) reusedSessions.push(id);
        return session;
      },
    },
    connectedAccounts: {
      list: async (query: {
        userIds: string[];
        cursor?: string;
        toolkitSlugs?: string[];
      }): Promise<{
        items: Array<{
          id: string;
          toolkit: { slug: string };
          status: string;
          isDisabled: boolean;
          data?: { scope: string };
        }>;
        nextCursor: string | null;
      }> => {
        calls.push({ user: query.userIds[0], cursor: query.cursor });
        const owner = query.userIds[0].endsWith(":1") ? "one" : "two";
        const items = query.cursor
          ? []
          : [
              {
                id: `account-${owner}`,
                toolkit: {
                  slug:
                    query.toolkitSlugs?.length === 1
                      ? query.toolkitSlugs[0]
                      : toolkit,
                },
                status: "ACTIVE",
                isDisabled: false,
                ...(scope ? { data: { scope } } : {}),
              },
            ];
        return { items, nextCursor: null };
      },
      revoke: async (id: string) => {
        revoked.push(id);
        return {};
      },
      delete: async (id: string) => {
        deleted.push(id);
        return {};
      },
    },
  };
  (service as unknown as { client: unknown }).client = client;
  return {
    service,
    calls,
    proxyCalls,
    setResponse: (value: unknown) => {
      response = value;
    },
    setScope: (value: string) => {
      scope = value;
    },
    setToolkit: (value: string) => {
      toolkit = value;
    },
    getCreated: () => created,
    db,
    client,
    revoked,
    deleted,
    createdUsers,
    reusedSessions,
  };
}

test("sessions expose only source toolkits and no remote sandbox", async (t) => {
  const h = fixture(t);
  await assert.rejects(
    h.service.connect(1n, "unknown"),
    (error: unknown) => error instanceof ApiError && error.status === 422,
  );
  // Connecting an already active toolkit requires an explicit disconnect.
  await assert.rejects(
    h.service.connect(1n, "hubspot"),
    (error: unknown) => error instanceof ApiError && error.status === 409,
  );
  await h.service.search(1n, {
    provider: "hubspot",
    kind: "company",
    accountId: "account-one",
    query: "Acme",
  });
  assert.deepEqual(h.getCreated(), {
    toolkits: [
      "salesforce",
      "hubspot",
      "gmail",
      "outlook",
      "notion",
      "googledrive",
    ],
    manageConnections: false,
    sandbox: { enable: false },
    multiAccount: { enable: false },
  });
});

test("an email-only Google grant requires reconnect before Drive reads", async (t) => {
  const h = fixture(t);
  h.setToolkit("googledrive");
  h.setScope("https://www.googleapis.com/auth/userinfo.email");
  const status = (await h.service.connections(1n)).find(
    (item) => item.provider === "googledrive",
  );
  assert.equal(status?.connected, false);
  assert.equal(status?.status, "PERMISSION_REQUIRED");
  assert.equal(status?.accountId, null);
  await assert.rejects(
    h.service.search(1n, {
      provider: "googledrive",
      kind: "document",
      accountId: "account-one",
      query: "Acme",
    }),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
  await h.service.connect(1n, "googledrive");
  assert.deepEqual(h.revoked, ["account-one"]);
  h.setScope("https://www.googleapis.com/auth/drive.readonly");
  assert.equal(
    (await h.service.connections(1n)).find(
      (item) => item.provider === "googledrive",
    )?.connected,
    true,
  );
});

test("mail connections require a scope that can read message bodies", async (t) => {
  const h = fixture(t);
  for (const [name, insufficient, readable] of [
    [
      "gmail",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
    ["outlook", "User.Read Mail.Send", "User.Read Mail.Read"],
  ]) {
    h.setToolkit(name);
    h.setScope(insufficient);
    const missing = (await h.service.connections(1n)).find(
      (item) => item.provider === name,
    );
    assert.equal(missing?.status, "PERMISSION_REQUIRED");
    assert.equal(missing?.connected, false);
    await assert.rejects(
      h.service.search(1n, {
        provider: name,
        kind: "thread",
        accountId: "account-one",
        query: "Acme",
      }),
      (error: unknown) => error instanceof ApiError && error.status === 403,
    );
    h.setScope(readable);
    assert.equal(
      (await h.service.connections(1n)).find((item) => item.provider === name)
        ?.connected,
      true,
    );
  }
});

test("connection status and unfinished disconnect paginate within one account", async (t) => {
  const h = fixture(t);
  let page = 0;
  h.client.connectedAccounts.list = async (query) => {
    assert.deepEqual(query.userIds, [USER_ONE]);
    page++;
    return page === 1
      ? {
          items: [
            {
              id: "pending",
              toolkit: { slug: "gmail" },
              status: "INITIATED",
              isDisabled: false,
            },
          ],
          nextCursor: "page-two",
        }
      : {
          items:
            query.toolkitSlugs?.length === 1 &&
            query.toolkitSlugs[0] === "gmail"
              ? []
              : [
                  {
                    id: "active",
                    toolkit: { slug: "hubspot" },
                    status: "ACTIVE",
                    isDisabled: false,
                  },
                ],
          nextCursor: null,
        };
  };
  const connections = await h.service.connections(1n);
  assert.equal(
    connections.find((item) => item.provider === "gmail")?.status,
    "INITIATED",
  );
  assert.equal(
    connections.find((item) => item.provider === "hubspot")?.accountId,
    "active",
  );
  page = 0;
  await h.service.disconnect(1n, "gmail");
  assert.deepEqual(h.deleted, ["pending"]);
  assert.deepEqual(h.revoked, []);
});

test("an abandoned connection link can be replaced", async (t) => {
  const h = fixture(t);
  let pending = true;
  h.client.connectedAccounts.list = async () => ({
    items: pending
      ? [
          {
            id: "old-link",
            toolkit: { slug: "hubspot" },
            status: "INITIALIZING",
            isDisabled: false,
          },
        ]
      : [],
    nextCursor: null,
  });
  h.client.connectedAccounts.delete = async (id) => {
    h.deleted.push(id);
    pending = false;
    return {};
  };
  assert.match((await h.service.connect(1n, "hubspot")).url, /^https:/);
  assert.deepEqual(h.deleted, ["old-link"]);
});

test("expired links can be disconnected and retried", async (t) => {
  const h = fixture(t);
  h.client.connectedAccounts.list = async () => ({
    items: [
      {
        id: "expired-link",
        toolkit: { slug: "notion" },
        status: "EXPIRED",
        isDisabled: false,
      },
    ],
    nextCursor: null,
  });
  await h.service.disconnect(1n, "notion");
  assert.match((await h.service.connect(1n, "notion")).url, /^https:/);
  assert.deepEqual(h.deleted, ["expired-link", "expired-link"]);
  assert.deepEqual(h.revoked, []);
});

test("account identity is scoped before any record request", async (t) => {
  const h = fixture(t);
  await assert.rejects(
    h.service.search(2n, {
      provider: "hubspot",
      kind: "company",
      accountId: "account-one",
      query: "Acme",
    }),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
  assert.equal(h.proxyCalls.length, 0);
  await h.service.search(1n, {
    provider: "hubspot",
    kind: "company",
    accountId: "account-one",
    query: "Acme",
  });
  assert.ok(h.calls.every((call) => call.user.startsWith("savvy:")));
});

test("search cursor, malformed records, size cap and request rate are enforced", async (t) => {
  const h = fixture(t);
  const query = {
    provider: "hubspot",
    kind: "company",
    accountId: "account-one",
    query: "Acme",
  };
  const first = await h.service.search(1n, query);
  assert.equal(first.nextCursor, "next-page");
  assert.equal(first.records[0].title, "Acme");
  await h.service.search(1n, { ...query, cursor: "next-page" });
  assert.deepEqual(h.proxyCalls.at(-1)?.body, {
    query: "Acme",
    limit: 20,
    after: "next-page",
  });
  h.setResponse({ results: "bad" });
  await assert.rejects(
    h.service.search(1n, query),
    (error: unknown) =>
      error instanceof ApiError && error.code === "provider_unavailable",
  );
  h.setResponse({ unexpected: [] });
  await assert.rejects(
    h.service.search(1n, query),
    (error: unknown) =>
      error instanceof ApiError && error.code === "provider_unavailable",
  );
  h.setResponse({
    id: "company-1",
    properties: { name: "Acme", description: "x".repeat(SOURCE_LIMIT) },
  });
  await assert.rejects(
    h.service.fetch(1n, {
      provider: "hubspot",
      kind: "company",
      accountId: "account-one",
      recordId: "company-1",
    }),
    (error: unknown) =>
      error instanceof ApiError && error.code === "context_too_large",
  );
  h.setResponse({ results: [] });
  for (let i = 4; i < 60; i++) await h.service.search(1n, query);
  await assert.rejects(
    h.service.search(1n, query),
    (error: unknown) =>
      error instanceof ApiError && error.code === "rate_limited",
  );
});

test("Gmail search accepts empty results and cleans highlighted snippets", async (t) => {
  const h = fixture(t);
  h.setToolkit("gmail");
  h.setScope("https://www.googleapis.com/auth/gmail.readonly");
  h.setResponse({ resultSizeEstimate: 0 });
  assert.deepEqual(
    await h.service.search(1n, {
      provider: "gmail",
      kind: "thread",
      accountId: "account-one",
      query: "missing subject",
    }),
    { records: [], nextCursor: null },
  );
  h.setResponse({
    threads: [
      { id: "thread-one", snippet: "Fictional <b>Acme</b> &amp; renewal" },
    ],
  });
  const result = await h.service.search(1n, {
    provider: "gmail",
    kind: "thread",
    accountId: "account-one",
    query: "Acme",
  });
  assert.equal(result.records[0].title, "Fictional Acme & renewal");
});

test("Notion search uses the page title property", async (t) => {
  const h = fixture(t);
  h.setResponse({
    results: [
      {
        id: "page-1",
        properties: {
          Name: { title: [{ plain_text: "Acme " }, { plain_text: "renewal" }] },
        },
        url: "https://notion.so/page-1",
        last_edited_time: "2026-10-16T11:00:00Z",
      },
    ],
    next_cursor: null,
  });
  const result = await h.service.search(1n, {
    provider: "notion",
    kind: "page",
    accountId: "account-one",
    query: "Acme",
  });
  assert.equal(result.records[0].title, "Acme renewal");
  const unrelated = await h.service.search(1n, {
    provider: "notion",
    kind: "page",
    accountId: "account-one",
    query: "Notes",
  });
  assert.equal(unrelated.records.length, 0);
});

test("Notion rejects an empty body before adding the page title and URL", async (t) => {
  const h = fixture(t);
  for (const blocks of [
    [],
    [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "   " }] } }],
  ]) {
    h.setResponse(({ endpoint }: { endpoint: string }) =>
      endpoint.includes("/blocks/")
        ? { results: blocks, next_cursor: null }
        : {
            properties: { Name: { title: [{ plain_text: "Acme renewal" }] } },
            url: "https://notion.so/acme",
          },
    );
    await assert.rejects(
      h.service.fetch(1n, {
        provider: "notion",
        kind: "page",
        accountId: "account-one",
        recordId: "page-1",
      }),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 422 &&
        error.code === "invalid_request" &&
        /no supported text/.test(error.message),
    );
  }
});

test("Gong is unavailable for discovery, connection and reads, but can be disconnected", async (t) => {
  const h = fixture(t);
  const unavailable = (error: unknown) =>
    error instanceof ApiError &&
    error.status === 422 &&
    /not available/.test(error.message);
  await assert.rejects(h.service.connect(1n, "gong"), unavailable);
  await assert.rejects(
    h.service.search(1n, {
      provider: "gong",
      kind: "call",
      accountId: "account-one",
      query: "Acme",
    }),
    unavailable,
  );
  await assert.rejects(
    h.service.fetch(1n, {
      provider: "gong",
      kind: "call",
      accountId: "account-one",
      recordId: "call-1",
    }),
    unavailable,
  );
  assert.equal(h.calls.length, 0);
  assert.equal(h.proxyCalls.length, 0);
  assert.equal(h.createdUsers.length, 0);
  h.setToolkit("gong");
  const connections = await h.service.connections(1n);
  assert.equal(connections.length, 6);
  assert.deepEqual(
    connections.map((item) => item.provider),
    ["salesforce", "hubspot", "gmail", "outlook", "notion", "googledrive"],
  );
  await h.service.disconnect(1n, "gong");
  assert.deepEqual(h.revoked, ["account-one"]);
});

test("the same internal account ID cannot discover another issuer's connections", async (t) => {
  const staging = fixture(t, "https://staging-api.savvycopilot.com");
  const production = fixture(t, "https://api.savvycopilot.com");
  await staging.service.connections(1n);
  const stagingUser = staging.calls[0].user;
  production.client.connectedAccounts.list = async (query) => {
    production.calls.push({ user: query.userIds[0] });
    return {
      items:
        query.userIds[0] === stagingUser
          ? [
              {
                id: "staging-account",
                toolkit: { slug: "hubspot" },
                status: "ACTIVE",
                isDisabled: false,
              },
            ]
          : [],
      nextCursor: null,
    };
  };
  assert.equal(
    (await production.service.connections(1n)).some((item) => item.connected),
    false,
  );
  assert.notEqual(production.calls[0].user, stagingUser);
  await assert.rejects(
    production.service.fetch(1n, {
      provider: "hubspot",
      kind: "company",
      accountId: "staging-account",
      recordId: "record-1",
    }),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
  assert.equal(production.proxyCalls.length, 0);
});

test("legacy and foreign-issuer session caches are replaced without reusing their sessions", async (t) => {
  const h = fixture(t);
  h.db.exec(`DROP TABLE composio_sessions;
    CREATE TABLE composio_sessions(account_id INTEGER PRIMARY KEY REFERENCES accounts(id),session_id TEXT NOT NULL UNIQUE);
    INSERT INTO composio_sessions(account_id,session_id) VALUES(1,'legacy-session');`);
  migrateService(h.db);
  assert.equal(
    h.db
      .prepare("SELECT user_id FROM composio_sessions WHERE account_id=1")
      .pluck()
      .get(),
    "",
  );
  await h.service.search(1n, {
    provider: "hubspot",
    kind: "company",
    accountId: "account-one",
    query: "Acme",
  });
  assert.deepEqual(h.createdUsers, [USER_ONE]);
  assert.deepEqual(h.reusedSessions, []);
  assert.equal(
    h.db
      .prepare("SELECT user_id FROM composio_sessions WHERE account_id=1")
      .pluck()
      .get(),
    USER_ONE,
  );
  await h.service.search(1n, {
    provider: "hubspot",
    kind: "company",
    accountId: "account-one",
    query: "Acme",
  });
  assert.deepEqual(h.reusedSessions, ["session-1"]);
  h.db
    .prepare(
      "UPDATE composio_sessions SET user_id=?,session_id='foreign-session' WHERE account_id=1",
    )
    .run("savvy:another-issuer:1");
  await h.service.search(1n, {
    provider: "hubspot",
    kind: "company",
    accountId: "account-one",
    query: "Acme",
  });
  assert.deepEqual(h.createdUsers, [USER_ONE, USER_ONE]);
  assert.deepEqual(h.reusedSessions, ["session-1"]);
  migrateService(h.db);
  assert.equal(
    h.db
      .prepare("SELECT user_id FROM composio_sessions WHERE account_id=1")
      .pluck()
      .get(),
    USER_ONE,
  );
});

for (const [name, secondIssuer] of [
  ["same-issuer requests share the winning cached session", ISSUER],
  [
    "different-issuer requests never reuse a foreign concurrent session",
    "https://staging.savvy.test",
  ],
] as const) {
  test(name, async (t) => {
    const h = fixture(t);
    const template = await h.client.sessions.use();
    const sessions = new Map<
      string,
      { user: string; session: typeof template }
    >();
    const reused: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const services = [
      h.service,
      new ComposioSources(
        {
          config: { issuer: secondIssuer },
          db: h.db,
          clock: () => 1_000n,
        } as ServiceState,
        "synthetic",
      ),
    ];
    for (const service of services) {
      let expectedUser: string;
      const client = {
        ...h.client,
        connectedAccounts: {
          ...h.client.connectedAccounts,
          list: async (
            query: Parameters<typeof h.client.connectedAccounts.list>[0],
          ) => {
            expectedUser = query.userIds[0];
            return h.client.connectedAccounts.list(query);
          },
        },
        sessions: {
          create: async (user: string) => {
            assert.equal(user, expectedUser);
            const session = {
              ...template,
              sessionId: `concurrent-session-${sessions.size + 1}`,
              proxyExecute: async (
                args: Parameters<typeof template.proxyExecute>[0],
              ) => {
                assert.equal(
                  user,
                  expectedUser,
                  "record request used a foreign session",
                );
                return template.proxyExecute(args);
              },
            };
            sessions.set(session.sessionId, { user, session });
            await gate;
            return session;
          },
          use: async (id: string) => {
            const saved = sessions.get(id);
            assert.ok(saved);
            assert.equal(
              saved.user,
              expectedUser,
              "foreign cached session reused",
            );
            reused.push(id);
            return saved.session;
          },
        },
      };
      (service as unknown as { client: unknown }).client = client;
    }
    const body = {
      provider: "hubspot",
      kind: "company",
      accountId: "account-one",
      query: "Acme",
    };
    const pending = services.map((service) => service.search(1n, body));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const started = sessions.size;
    release();
    const results = await Promise.all(pending);
    assert.equal(started, 2, "both requests must reach uncached creation");
    assert.ok(results.every((result) => result.records[0].title === "Acme"));
    const row = h.db
      .prepare<[], { session_id: string; user_id: string }>(
        "SELECT session_id,user_id FROM composio_sessions WHERE account_id=1",
      )
      .get()!;
    assert.equal(sessions.get(row.session_id)?.user, row.user_id);
    if (secondIssuer === ISSUER) {
      assert.deepEqual(reused, [row.session_id]);
      await services[0].search(1n, body);
      assert.equal(sessions.size, 2);
      assert.deepEqual(reused, [row.session_id, row.session_id]);
    } else assert.deepEqual(reused, []);
  });
}

test("Salesforce reads use the configured API base and retain record links", async (t) => {
  const h = fixture(t);
  const noteText = "<p>Security review on Friday</p>";
  let noteUrl =
    "https://temp.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/note";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), noteUrl);
    return new Response(noteText);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const session = await h.client.sessions.use();
  const execute = session.proxyExecute;
  session.proxyExecute = async (args) => {
    const result = await execute(args);
    return args.endpoint.endsWith("/Content")
      ? {
          ...result,
          data: null,
          binaryData: { url: noteUrl, size: Buffer.byteLength(noteText) },
        }
      : result;
  };
  const accounts = h.client.connectedAccounts.list;
  h.client.connectedAccounts.list = async (query) => {
    const result = await accounts(query);
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        data: { scope: "", subdomain: "acme.my" },
      })),
    };
  };
  for (const [kind, object] of [
    ["account", "Account"],
    ["opportunity", "Opportunity"],
    ["note", "ContentNote"],
  ]) {
    h.setResponse(({ endpoint }: { endpoint: string }) => {
      assert.ok(
        endpoint === "/query" ||
          endpoint === `/sobjects/${object}/record-1` ||
          (kind === "note" &&
            endpoint === "/sobjects/ContentNote/record-1/Content"),
      );
      if (endpoint.endsWith("/Content")) return null;
      return endpoint === "/query"
        ? {
            records: [
              { Id: "record-1", [kind === "note" ? "Title" : "Name"]: "Acme" },
            ],
          }
        : {
            Name: "Acme",
            Description: "Security review on Friday",
            Content:
              "/services/data/v67.0/sobjects/ContentNote/record-1/Content",
            LastModifiedDate: "2026-10-24T12:00:00Z",
          };
    });
    const found = await h.service.search(1n, {
      provider: "salesforce",
      kind,
      accountId: "account-one",
      query: "Acme",
    });
    assert.equal(found.records[0].title, "Acme");
    const source = await h.service.fetch(1n, found.records[0]);
    assert.match(source.content, /Security review on Friday/);
    assert.doesNotMatch(source.content, /<p>|\uFFFD/);
    assert.equal(source.url, "https://acme.my.salesforce.com/record-1");
  }
  noteUrl = "https://r2.cloudflarestorage.com.evil.test/note";
  await assert.rejects(
    h.service.fetch(1n, {
      provider: "salesforce",
      kind: "note",
      accountId: "account-one",
      recordId: "record-1",
    }),
    (error: unknown) =>
      error instanceof ApiError && error.code === "provider_unavailable",
  );
});

test("CRM, mail, page and Drive adapters retain provider text", async (t) => {
  const h = fixture(t);
  const cases = [
    {
      provider: "salesforce",
      kind: "account",
      text: "Renewal in October",
      response: () => ({ Name: "Acme", Description: "Renewal in October" }),
    },
    {
      provider: "gmail",
      kind: "thread",
      text: "Budget approved",
      response: () => ({
        messages: [
          {
            internalDate: "1790000000000",
            payload: {
              headers: [{ name: "Subject", value: "Renewal" }],
              mimeType: "text/plain",
              body: { data: Buffer.from("Budget approved").toString("base64") },
            },
          },
        ],
      }),
    },
    {
      provider: "outlook",
      kind: "thread",
      text: "Legal signed",
      response: () => ({
        value: [
          { subject: "Renewal", body: { content: "<p>Legal signed</p>" } },
        ],
      }),
    },
    {
      provider: "notion",
      kind: "page",
      text: "Implementation starts Monday",
      response: ({ endpoint }: { endpoint: string }) =>
        endpoint.includes("/children")
          ? {
              results: [
                {
                  type: "paragraph",
                  paragraph: {
                    rich_text: [{ plain_text: "Implementation starts Monday" }],
                  },
                },
              ],
              next_cursor: null,
            }
          : {
              properties: { Name: { title: [{ plain_text: "Plan" }] } },
              url: "https://notion.so/plan",
            },
    },
    {
      provider: "googledrive",
      kind: "document",
      text: "Customer playbook",
      response: ({ endpoint }: { endpoint: string }) =>
        endpoint.endsWith("/files/record-1") &&
        h.proxyCalls.at(-1)?.parameters &&
        JSON.stringify(h.proxyCalls.at(-1)?.parameters).includes("alt")
          ? "Customer playbook"
          : {
              name: "Playbook",
              mimeType: "text/plain",
              webViewLink: "https://drive.google.com/file/record-1",
            },
    },
  ] as const;
  for (const item of cases) {
    h.setResponse(item.response);
    const result = await h.service.fetch(1n, {
      provider: item.provider,
      kind: item.kind,
      accountId: "account-one",
      recordId: "record-1",
    });
    assert.match(result.content, new RegExp(item.text));
  }
});

test("Drive download stops at the source limit without a content-length header", async (t) => {
  const h = fixture(t);
  const session = await h.client.sessions.use();
  session.proxyExecute = async (args) => {
    const download = JSON.stringify(args.parameters).includes('"alt"');
    return {
      status: 200,
      data: download
        ? {}
        : {
            name: "Playbook",
            mimeType: "text/plain",
            webViewLink: "https://drive.google.com/file/record-1",
          },
      binaryData: download
        ? { size: 0, url: "https://files.composio.dev/test" }
        : undefined,
    };
  };
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(SOURCE_LIMIT));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }),
      ),
  );
  await assert.rejects(
    h.service.fetch(1n, {
      provider: "googledrive",
      kind: "document",
      accountId: "account-one",
      recordId: "record-1",
    }),
    (error: unknown) =>
      error instanceof ApiError && error.code === "context_too_large",
  );
});
