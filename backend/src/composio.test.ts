import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { openServiceDatabase } from "./db.js";
import { ComposioSources, SOURCE_LIMIT } from "./composio.js";
import { ApiError } from "./errors.js";
import type { ServiceState } from "./state.js";

function fixture(t: TestContext) {
  const db = openServiceDatabase(":memory:");
  t.after(() => db.close());
  db.prepare(
    "INSERT INTO accounts(id,issuer,subject,created_at_ms) VALUES(1,'test','one',0),(2,'test','two',0)",
  ).run();
  const state = { db, clock: () => 1_000n } as ServiceState;
  const service = new ComposioSources(state, "synthetic");
  const calls: Array<{ user: string; cursor?: string }> = [];
  const proxyCalls: Array<{
    endpoint: string;
    parameters?: unknown;
    body?: unknown;
  }> = [];
  const revoked: string[] = [];
  const deleted: string[] = [];
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
      create: async (_user: string, config: unknown) => {
        created = config;
        return session;
      },
      use: async () => session,
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
        const owner = query.userIds[0] === "savvy:1" ? "one" : "two";
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
      "gong",
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
    assert.deepEqual(query.userIds, ["savvy:1"]);
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

test("Gmail search accepts its empty result response", async (t) => {
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

test("Gong transcript becomes local evidence with the call URL", async (t) => {
  const h = fixture(t);
  h.setResponse({
    calls: [
      {
        metaData: {
          id: "123",
          title: "Acme renewal",
          url: "https://app.gong.io/call?id=123",
          started: "2026-10-01T12:00:00Z",
        },
      },
    ],
    records: { cursor: "later" },
  });
  const search = await h.service.search(1n, {
    provider: "gong",
    kind: "call",
    accountId: "account-one",
    query: "Acme",
  });
  assert.equal(search.records[0].recordId, "123");
  assert.equal(search.nextCursor, "later");
  const original = h.proxyCalls.length;
  let count = 0;
  const service = h.service as unknown as {
    client: {
      sessions: {
        use: () => Promise<{ proxyExecute: () => Promise<unknown> }>;
      };
    };
  };
  const session = await service.client.sessions.use();
  session.proxyExecute = async () => ({
    status: 200,
    data:
      count++ === 0
        ? {
            calls: [
              {
                metaData: {
                  id: "123",
                  title: "Acme renewal",
                  url: "https://app.gong.io/call?id=123",
                },
              },
            ],
          }
        : {
            callTranscripts: [
              {
                callId: "123",
                transcript: [
                  { speakerId: "rep", sentences: [{ text: "Price holds." }] },
                ],
              },
            ],
          },
  });
  const fetched = await h.service.fetch(1n, {
    provider: "gong",
    kind: "call",
    accountId: "account-one",
    recordId: "123",
  });
  assert.match(fetched.content, /rep: Price holds\./);
  assert.equal(fetched.url, "https://app.gong.io/call?id=123");
  assert.equal(h.proxyCalls.length, original);
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
