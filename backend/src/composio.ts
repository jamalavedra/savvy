import { Composio } from "@composio/core";
import type { ServiceState } from "./state.js";
import { ApiError } from "./errors.js";
import { reserveAttempt } from "./billing.js";

export const SOURCE_LIMIT = 256 * 1024;
export const PROVIDERS = [
  "salesforce",
  "hubspot",
  "gong",
  "gmail",
  "outlook",
  "notion",
  "googledrive",
] as const;
export type Provider = (typeof PROVIDERS)[number];
const KINDS: Record<Provider, readonly string[]> = {
  salesforce: ["account", "opportunity", "note"],
  hubspot: ["company", "deal", "note"],
  gong: ["call"],
  gmail: ["thread"],
  outlook: ["thread"],
  notion: ["page"],
  googledrive: ["document"],
};

type RecordPreview = {
  provider: Provider;
  kind: string;
  accountId: string;
  recordId: string;
  title: string;
  url: string;
  modifiedAt: string | null;
};

function missingReadScope(name: string, data: unknown): boolean {
  if (name !== "googledrive" || !data || typeof data !== "object") return false;
  const scope = (data as Record<string, unknown>).scope;
  return (
    typeof scope === "string" &&
    !scope
      .split(/[\s,]+/)
      .some((value) =>
        [
          "https://www.googleapis.com/auth/drive",
          "https://www.googleapis.com/auth/drive.readonly",
        ].includes(value),
      )
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError(
      "provider_unavailable",
      "connected source returned an unexpected response",
    );
  return value as Record<string, unknown>;
}
function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function list(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value))
    throw new ApiError(
      "provider_unavailable",
      "connected source returned an unexpected list",
    );
  return value.map(record);
}
function bounded(value: unknown): Record<string, unknown> {
  const data = record(value);
  if (Buffer.byteLength(JSON.stringify(data)) > 1_048_576)
    throw new ApiError(
      "context_too_large",
      "connected source response is too large",
    );
  return data;
}
function provider(value: unknown): Provider {
  if (!PROVIDERS.includes(value as Provider))
    throw new ApiError(
      "invalid_request",
      "unsupported connected source",
      undefined,
      422,
    );
  return value as Provider;
}
function kindFor(name: Provider, value: unknown): string {
  if (typeof value !== "string" || !KINDS[name].includes(value))
    throw new ApiError(
      "invalid_request",
      "unsupported record type",
      undefined,
      422,
    );
  return value;
}
function input(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new ApiError("invalid_request", `invalid ${label}`, undefined, 422);
  return value.trim();
}
function sourceText(value: string): string {
  if (!value.trim())
    throw new ApiError(
      "invalid_request",
      "record has no supported text",
      undefined,
      422,
    );
  if (Buffer.byteLength(value) > SOURCE_LIMIT)
    throw new ApiError(
      "context_too_large",
      "record exceeds the 256 KiB import limit",
    );
  return value;
}
function markdown(title: string, url: string, content: string): string {
  return sourceText(
    `# ${title.replace(/[\r\n]+/g, " ")}\n\nSource: ${url}\n\n${content}`,
  );
}
function textFields(value: Record<string, unknown>): string {
  return Object.entries(value)
    .filter(
      ([key, item]) =>
        !["id", "url", "webViewLink"].includes(key) &&
        (typeof item === "string" || typeof item === "number"),
    )
    .map(([key, item]) => `**${key}:** ${String(item)}`)
    .join("\n\n");
}
function cleanHtml(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(
      /&(?:amp|lt|gt|quot|#39);/g,
      (match) =>
        ({
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&#39;": "'",
        })[match] ?? match,
    );
}
function base64Text(value: string): string {
  return Buffer.from(
    value.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
}
function gmailText(payload: Record<string, unknown>): string {
  const parts = Array.isArray(payload.parts) ? list(payload.parts) : [];
  const plain = [payload, ...parts].find(
    (item) =>
      item.mimeType === "text/plain" && str(record(item.body ?? {}).data),
  );
  if (plain) return base64Text(str(record(plain.body).data));
  const html = [payload, ...parts].find(
    (item) =>
      item.mimeType === "text/html" && str(record(item.body ?? {}).data),
  );
  if (html) return cleanHtml(base64Text(str(record(html.body).data)));
  if (str(record(payload.body ?? {}).data))
    return base64Text(str(record(payload.body).data));
  return parts.map(gmailText).find(Boolean) ?? "";
}

export class ComposioSources {
  private client: Composio;
  constructor(
    private state: ServiceState,
    apiKey: string,
  ) {
    this.client = new Composio({ apiKey });
  }
  private user(account: bigint) {
    return `savvy:${account}`;
  }
  private limit(account: bigint, action: string, count: bigint) {
    this.state.db
      .transaction(() =>
        reserveAttempt(
          this.state.db,
          account,
          `composio:${action}`,
          this.state.clock(),
          60_000n,
          count,
        ),
      )
      .immediate();
  }
  private async session(account: bigint) {
    const row = this.state.db
      .prepare<[bigint], { session_id: string }>(
        "SELECT session_id FROM composio_sessions WHERE account_id=?",
      )
      .get(account);
    if (row) return this.client.sessions.use(row.session_id);
    // shortcut: Composio disables proxy reads with a tool list; use session.execute
    // once the project key can list and execute tools. Search/fetch fix the read endpoints.
    const session = await this.client.sessions.create(this.user(account), {
      toolkits: [...PROVIDERS],
      manageConnections: false,
      sandbox: { enable: false },
      multiAccount: { enable: false },
    });
    this.state.db
      .prepare(
        "INSERT OR IGNORE INTO composio_sessions(account_id,session_id) VALUES(?,?)",
      )
      .run(account, session.sessionId);
    const saved = this.state.db
      .prepare<[bigint], { session_id: string }>(
        "SELECT session_id FROM composio_sessions WHERE account_id=?",
      )
      .get(account)!;
    return saved.session_id === session.sessionId
      ? session
      : this.client.sessions.use(saved.session_id);
  }
  private async accounts(account: bigint, name?: Provider, activeOnly = true) {
    const items = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await this.client.connectedAccounts.list({
        userIds: [this.user(account)],
        toolkitSlugs: name ? [name] : [...PROVIDERS],
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      items.push(
        ...result.items.filter(
          (item) =>
            (!activeOnly ||
              (item.status === "ACTIVE" &&
                !item.isDisabled &&
                !missingReadScope(item.toolkit.slug, item.data))) &&
            (!name || item.toolkit.slug === name) &&
            PROVIDERS.includes(item.toolkit.slug as Provider),
        ),
      );
      cursor = result.nextCursor ?? undefined;
      if (items.length > 100 || (cursor && seen.has(cursor)))
        throw new ApiError(
          "provider_unavailable",
          "connected account pagination failed",
        );
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
  async connections(account: bigint) {
    this.limit(account, "connections", 120n);
    const accounts = await this.accounts(account, undefined, false);
    return PROVIDERS.map((name) => {
      const connection =
        accounts.find(
          (item) =>
            item.toolkit.slug === name &&
            item.status === "ACTIVE" &&
            !item.isDisabled &&
            !missingReadScope(item.toolkit.slug, item.data),
        ) ??
        accounts.find(
          (item) => item.toolkit.slug === name && item.status !== "REVOKED",
        );
      return {
        provider: name,
        accountId:
          connection?.status === "ACTIVE" &&
          !connection.isDisabled &&
          !missingReadScope(connection.toolkit.slug, connection.data)
            ? connection.id
            : null,
        connected:
          connection?.status === "ACTIVE" &&
          !connection.isDisabled &&
          !missingReadScope(connection.toolkit.slug, connection.data),
        status:
          connection?.status === "ACTIVE" &&
          missingReadScope(connection.toolkit.slug, connection.data)
            ? "PERMISSION_REQUIRED"
            : (connection?.status ?? "DISCONNECTED"),
      };
    });
  }
  async connect(account: bigint, rawProvider: unknown) {
    this.limit(account, "connect", 10n);
    const name = provider(rawProvider);
    for (const item of await this.accounts(account, name, false)) {
      if (item.status === "ACTIVE" && missingReadScope(name, item.data))
        await this.client.connectedAccounts.revoke(item.id);
      else if (item.status === "ACTIVE")
        throw new ApiError(
          "invalid_request",
          "disconnect the existing account first",
          undefined,
          409,
        );
      if (item.status !== "REVOKED")
        await this.client.connectedAccounts.delete(item.id);
    }
    const session = await this.session(account);
    const link = await session.authorize(name);
    if (!link.redirectUrl?.startsWith("https://"))
      throw new ApiError(
        "provider_unavailable",
        "connection link is unavailable",
      );
    return { url: link.redirectUrl };
  }
  async disconnect(account: bigint, rawProvider: unknown) {
    this.limit(account, "disconnect", 10n);
    const name = provider(rawProvider);
    for (const item of await this.accounts(account, name, false))
      if (item.status === "ACTIVE")
        await this.client.connectedAccounts.revoke(item.id);
      else if (item.status !== "REVOKED")
        await this.client.connectedAccounts.delete(item.id);
    return { connected: false };
  }
  private async active(account: bigint, name: Provider, accountId: string) {
    const accounts = await this.accounts(account, name);
    if (
      accounts.length !== 1 ||
      accounts[0].id !== accountId ||
      accounts[0].toolkit.slug !== name
    )
      throw new ApiError(
        "sign_in_required",
        "connected account is no longer available",
        undefined,
        403,
      );
  }
  private async proxy(
    account: bigint,
    name: Provider,
    endpoint: string,
    method: "GET" | "POST",
    parameters?: Array<{
      in: "query" | "header";
      name: string;
      value: string | number;
    }>,
    body?: unknown,
  ) {
    const session = await this.session(account);
    const result = await session.proxyExecute({
      toolkit: name,
      endpoint,
      method,
      ...(parameters || name === "notion"
        ? {
            parameters: [
              ...(parameters ?? []),
              ...(name === "notion"
                ? [
                    {
                      in: "header" as const,
                      name: "Notion-Version",
                      value: "2022-06-28",
                    },
                  ]
                : []),
            ],
          }
        : {}),
      ...(body ? { body } : {}),
    });
    if (result.status === 429)
      throw new ApiError("rate_limited", "connected source is rate limited");
    if (result.status < 200 || result.status >= 300)
      throw new ApiError(
        "provider_unavailable",
        `connected source returned ${result.status}`,
      );
    if (result.binaryData) {
      if (result.binaryData.size > SOURCE_LIMIT)
        throw new ApiError(
          "context_too_large",
          "record exceeds the 256 KiB import limit",
        );
      const url = new URL(result.binaryData.url);
      if (
        url.protocol !== "https:" ||
        !/(?:^|\.)(?:amazonaws\.com|composio\.dev|googleapis\.com)$/.test(
          url.hostname,
        )
      )
        throw new ApiError(
          "provider_unavailable",
          "connected source returned an unsafe download URL",
        );
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (
        !response.ok ||
        Number(response.headers.get("content-length") ?? 0) > SOURCE_LIMIT
      )
        throw new ApiError(
          "provider_unavailable",
          "connected document download failed",
        );
      if (!response.body)
        throw new ApiError(
          "provider_unavailable",
          "connected document download failed",
        );
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > SOURCE_LIMIT) {
            await reader.cancel().catch(() => {});
            throw new ApiError(
              "context_too_large",
              "record exceeds the 256 KiB import limit",
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks, size);
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    }
    if (typeof result.data === "string")
      return { text: sourceText(result.data) };
    return bounded(result.data);
  }
  async search(account: bigint, body: Record<string, unknown>) {
    this.limit(account, "search", 60n);
    const name = provider(body.provider),
      kind = kindFor(name, body.kind);
    const query = input(body.query, "search", 120);
    const cursor = body.cursor == null ? "" : input(body.cursor, "cursor", 512);
    const accountId = input(body.accountId, "account", 120);
    await this.active(account, name, accountId);
    let data: Record<string, unknown>;
    const offset =
      cursor && ["salesforce", "outlook"].includes(name) ? Number(cursor) : 0;
    if (
      ["salesforce", "outlook"].includes(name) &&
      (!Number.isSafeInteger(offset) || offset < 0 || offset > 1980)
    )
      throw new ApiError(
        "invalid_request",
        "invalid search cursor",
        undefined,
        422,
      );
    if (name === "salesforce") {
      const object = {
        account: "Account",
        opportunity: "Opportunity",
        note: "ContentNote",
      }[kind]!;
      const term = query.replace(/[\\']/g, "\\$&").replace(/[%_]/g, "\\$&");
      const field = kind === "note" ? "Title" : "Name";
      data = await this.proxy(
        account,
        name,
        "/services/data/v61.0/query",
        "GET",
        [
          {
            in: "query",
            name: "q",
            value: `SELECT Id,${field},LastModifiedDate FROM ${object} WHERE ${field} LIKE '%${term}%' ORDER BY LastModifiedDate DESC LIMIT 20 OFFSET ${offset}`,
          },
        ],
      );
    } else if (name === "hubspot") {
      const object = { company: "companies", deal: "deals", note: "notes" }[
        kind
      ]!;
      data = await this.proxy(
        account,
        name,
        `/crm/v3/objects/${object}/search`,
        "POST",
        undefined,
        { query, limit: 20, ...(cursor ? { after: cursor } : {}) },
      );
    } else if (name === "gong") {
      data = await this.proxy(
        account,
        name,
        "/v2/calls/extensive",
        "POST",
        undefined,
        {
          filter: {
            fromDateTime: new Date(Date.now() - 365 * 86_400_000).toISOString(),
          },
          ...(cursor ? { cursor } : {}),
        },
      );
    } else if (name === "gmail") {
      data = await this.proxy(
        account,
        name,
        "/gmail/v1/users/me/threads",
        "GET",
        [
          { in: "query", name: "q", value: query },
          { in: "query", name: "maxResults", value: 20 },
          ...(cursor
            ? [{ in: "query" as const, name: "pageToken", value: cursor }]
            : []),
        ],
      );
    } else if (name === "outlook") {
      data = await this.proxy(account, name, "/v1.0/me/messages", "GET", [
        {
          in: "query",
          name: "$search",
          value: `"${query.replaceAll('"', "")}"`,
        },
        { in: "query", name: "$top", value: 20 },
        ...(offset
          ? [{ in: "query" as const, name: "$skip", value: offset }]
          : []),
      ]);
    } else if (name === "notion") {
      data = await this.proxy(account, name, "/v1/search", "POST", undefined, {
        query,
        filter: { property: "object", value: "page" },
        page_size: 20,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
    } else {
      const escaped = query.replace(/[\\']/g, "\\$&");
      data = await this.proxy(account, name, "/files", "GET", [
        {
          in: "query",
          name: "q",
          value: `name contains '${escaped}' and trashed = false`,
        },
        {
          in: "query",
          name: "fields",
          value:
            "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,size)",
        },
        { in: "query", name: "pageSize", value: 20 },
        ...(cursor
          ? [{ in: "query" as const, name: "pageToken", value: cursor }]
          : []),
      ]);
    }
    const items = list(
      (name === "gong" ? data.calls : undefined) ??
        data.records ??
        data.results ??
        data.calls ??
        data.threads ??
        data.files ??
        data.value,
    );
    const records: RecordPreview[] = items.slice(0, 100).flatMap((item) => {
      const props =
        item.properties && typeof item.properties === "object"
          ? record(item.properties)
          : item;
      const metadata =
        item.metaData && typeof item.metaData === "object"
          ? record(item.metaData)
          : item;
      const id = str(item.Id ?? item.id ?? metadata.id);
      const notionTitle =
        name === "notion"
          ? Object.values(props)
              .flatMap((value) =>
                Array.isArray(record(value).title)
                  ? list(record(value).title).map((part) =>
                      str(part.plain_text),
                    )
                  : [],
              )
              .join("")
          : "";
      const title = str(
        notionTitle ||
          (item.title ??
            metadata.title ??
            item.name ??
            item.subject ??
            props.name ??
            props.dealname ??
            props.hs_note_body ??
            item.snippet),
        "Untitled",
      );
      if (
        ["gong", "notion"].includes(name) &&
        !title.toLowerCase().includes(query.toLowerCase())
      )
        return [];
      if (
        !id ||
        (name === "googledrive" &&
          ![
            "text/plain",
            "text/markdown",
            "application/vnd.google-apps.document",
          ].includes(str(item.mimeType)))
      )
        return [];
      return [
        {
          provider: name,
          kind,
          accountId,
          recordId: name === "outlook" ? str(item.conversationId, id) : id,
          title: title.slice(0, 200),
          url: str(
            item.webViewLink ?? item.webLink ?? item.url ?? metadata.url,
            "",
          ),
          modifiedAt:
            str(
              item.modifiedTime ??
                metadata.started ??
                item.last_edited_time ??
                item.LastModifiedDate ??
                item.updatedAt ??
                item.lastModifiedDateTime,
            ) || null,
        },
      ];
    });
    const paging =
      data.paging && typeof data.paging === "object" ? record(data.paging) : {};
    const next =
      paging.next && typeof paging.next === "object"
        ? record(paging.next).after
        : undefined;
    const gongCursor =
      data.records &&
      typeof data.records === "object" &&
      !Array.isArray(data.records)
        ? record(data.records).cursor
        : undefined;
    return {
      records: [
        ...new Map(records.map((item) => [item.recordId, item])).values(),
      ],
      nextCursor:
        name === "salesforce" || name === "outlook"
          ? items.length === 20 && offset < 1980
            ? String(offset + 20)
            : null
          : str(
              data.nextPageToken ??
                data.next_cursor ??
                data.cursor ??
                gongCursor ??
                next,
            ) || null,
    };
  }
  async fetch(account: bigint, body: Record<string, unknown>) {
    this.limit(account, "fetch", 30n);
    const name = provider(body.provider),
      kind = kindFor(name, body.kind);
    const accountId = input(body.accountId, "account", 120);
    const recordId = input(body.recordId, "record", 512);
    await this.active(account, name, accountId);
    let data: Record<string, unknown>;
    // shortcut: CRM REST records may omit browser URLs; resolve account-specific links after live provider validation.
    let title = "Untitled",
      url = "",
      modifiedAt: string | null = null,
      content = "";
    if (name === "salesforce") {
      const object = {
        account: "Account",
        opportunity: "Opportunity",
        note: "ContentNote",
      }[kind]!;
      data = await this.proxy(
        account,
        name,
        `/services/data/v61.0/sobjects/${object}/${encodeURIComponent(recordId)}`,
        "GET",
      );
      title = str(data.Name ?? data.Title, title);
      modifiedAt = str(data.LastModifiedDate) || null;
      url = str(data.url ?? data.webUrl);
      content =
        kind === "note" && str(data.Content)
          ? base64Text(str(data.Content))
          : textFields(data);
    } else if (name === "hubspot") {
      const object = { company: "companies", deal: "deals", note: "notes" }[
        kind
      ]!;
      const properties = {
        company: "name,description,domain,industry,city,notes_last_updated",
        deal: "dealname,description,amount,dealstage,closedate",
        note: "hs_note_body,hs_timestamp",
      }[kind]!;
      data = await this.proxy(
        account,
        name,
        `/crm/v3/objects/${object}/${encodeURIComponent(recordId)}`,
        "GET",
        [{ in: "query", name: "properties", value: properties }],
      );
      const props = record(data.properties);
      title = str(
        props.name ?? props.dealname,
        kind === "note" ? "HubSpot note" : title,
      );
      modifiedAt = str(data.updatedAt) || null;
      content = textFields(props);
      url = str(data.url ?? data.webUrl);
    } else if (name === "gong") {
      const details = await this.proxy(
        account,
        name,
        "/v2/calls/extensive",
        "POST",
        undefined,
        { filter: { callIds: [recordId] } },
      );
      const call = list(details.calls)[0];
      if (!call || str(record(call.metaData).id) !== recordId)
        throw new ApiError(
          "provider_unavailable",
          "Gong call metadata is unavailable",
        );
      const metadata = record(call.metaData);
      title = str(metadata.title, "Gong call");
      url = str(metadata.url);
      modifiedAt = str(metadata.started) || null;
      data = await this.proxy(
        account,
        name,
        "/v2/calls/transcript",
        "POST",
        undefined,
        { filter: { callIds: [recordId] } },
      );
      const transcript = list(data.callTranscripts).find(
        (item) => str(item.callId) === recordId,
      );
      if (!transcript)
        throw new ApiError(
          "provider_unavailable",
          "Gong transcript is unavailable",
        );
      content = list(transcript.transcript)
        .map(
          (turn) =>
            `${str(turn.speakerId)}: ${list(turn.sentences)
              .map((sentence) => str(sentence.text))
              .join(" ")}`,
        )
        .join("\n\n");
    } else if (name === "gmail") {
      data = await this.proxy(
        account,
        name,
        `/gmail/v1/users/me/threads/${encodeURIComponent(recordId)}`,
        "GET",
        [{ in: "query", name: "format", value: "full" }],
      );
      const messages = list(data.messages);
      title = str(
        record(messages[0]?.payload ?? {}).headers &&
          list(record(messages[0]?.payload ?? {}).headers).find(
            (h) => str(h.name).toLowerCase() === "subject",
          )?.value,
        "Gmail thread",
      );
      modifiedAt = messages.at(-1)?.internalDate
        ? new Date(Number(messages.at(-1)!.internalDate)).toISOString()
        : null;
      content = messages
        .map((message) => sourceText(gmailText(record(message.payload))))
        .join("\n\n---\n\n");
      url = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(recordId)}`;
    } else if (name === "outlook") {
      const safeId = recordId.replaceAll("'", "''");
      data = await this.proxy(account, name, "/v1.0/me/messages", "GET", [
        {
          in: "query",
          name: "$filter",
          value: `conversationId eq '${safeId}'`,
        },
        { in: "query", name: "$top", value: 50 },
      ]);
      const messages = list(data.value);
      title = str(messages[0]?.subject, "Outlook thread");
      modifiedAt = str(messages.at(-1)?.lastModifiedDateTime) || null;
      content = messages
        .map((message) =>
          sourceText(cleanHtml(str(record(message.body ?? {}).content))),
        )
        .join("\n\n---\n\n");
      url = str(messages[0]?.webLink);
      if (data["@odata.nextLink"])
        throw new ApiError(
          "context_too_large",
          "thread has more than 50 messages",
        );
    } else if (name === "notion") {
      data = await this.proxy(
        account,
        name,
        `/v1/pages/${encodeURIComponent(recordId)}`,
        "GET",
      );
      title = str(
        Object.values(record(data.properties ?? {}))
          .flatMap((v) =>
            Array.isArray(record(v).title)
              ? list(record(v).title).map((r) => str(r.plain_text))
              : [],
          )
          .join(""),
        "Notion page",
      );
      modifiedAt = str(data.last_edited_time) || null;
      url = str(data.url);
      let count = 0;
      const readBlocks = async (
        id: string,
        depth: number,
      ): Promise<string[]> => {
        if (depth > 8)
          throw new ApiError(
            "context_too_large",
            "page nesting exceeds the import limit",
          );
        const lines: string[] = [];
        let cursor = "";
        do {
          const blocks = await this.proxy(
            account,
            name,
            `/v1/blocks/${encodeURIComponent(id)}/children`,
            "GET",
            [
              { in: "query", name: "page_size", value: 100 },
              ...(cursor
                ? [
                    {
                      in: "query" as const,
                      name: "start_cursor",
                      value: cursor,
                    },
                  ]
                : []),
            ],
          );
          for (const block of list(blocks.results)) {
            if (++count > 200)
              throw new ApiError(
                "context_too_large",
                "page has too many blocks",
              );
            const type = str(block.type);
            const inner = record(block[type] ?? {});
            const rich = list(inner.rich_text ?? [])
              .map((part) => str(part.plain_text))
              .join("");
            if (rich) lines.push(rich);
            else if (type === "table_row")
              lines.push(
                (Array.isArray(inner.cells) ? inner.cells : [])
                  .map((cell) =>
                    list(cell)
                      .map((part) => str(part.plain_text))
                      .join(""),
                  )
                  .join(" | "),
              );
            else if (!["paragraph", "divider", "table"].includes(type))
              throw new ApiError(
                "invalid_request",
                `unsupported Notion block: ${type}`,
                undefined,
                422,
              );
            if (block.has_children)
              lines.push(...(await readBlocks(str(block.id), depth + 1)));
          }
          cursor = str(blocks.next_cursor);
        } while (cursor);
        return lines;
      };
      content = (await readBlocks(recordId, 0)).join("\n\n");
    } else {
      data = await this.proxy(
        account,
        name,
        `/files/${encodeURIComponent(recordId)}`,
        "GET",
        [
          {
            in: "query",
            name: "fields",
            value: "id,name,mimeType,modifiedTime,webViewLink,size",
          },
        ],
      );
      title = str(data.name, title);
      modifiedAt = str(data.modifiedTime) || null;
      url = str(data.webViewLink);
      const mime = str(data.mimeType);
      if (
        ![
          "text/plain",
          "text/markdown",
          "application/vnd.google-apps.document",
        ].includes(mime)
      )
        throw new ApiError(
          "invalid_request",
          "unsupported Drive document type",
          undefined,
          422,
        );
      if (Number(data.size ?? 0) > SOURCE_LIMIT)
        throw new ApiError(
          "context_too_large",
          "record exceeds the 256 KiB import limit",
        );
      const endpoint =
        mime === "application/vnd.google-apps.document"
          ? `/files/${encodeURIComponent(recordId)}/export`
          : `/files/${encodeURIComponent(recordId)}`;
      const document = await this.proxy(account, name, endpoint, "GET", [
        {
          in: "query",
          name:
            mime === "application/vnd.google-apps.document"
              ? "mimeType"
              : "alt",
          value:
            mime === "application/vnd.google-apps.document"
              ? "text/plain"
              : "media",
        },
      ]);
      content = str(document.text);
    }
    if (
      title.length > 200 ||
      url.length > 2048 ||
      (url && !/^https?:\/\//.test(url))
    )
      throw new ApiError(
        "provider_unavailable",
        "connected source returned invalid metadata",
      );
    return {
      provider: name,
      kind,
      accountId,
      recordId,
      title,
      url,
      modifiedAt,
      content: markdown(title, url, content),
    };
  }
}

const instances = new WeakMap<ServiceState, ComposioSources>();
export function sources(state: ServiceState): ComposioSources {
  if (!state.config.composioKey)
    throw new ApiError(
      "provider_unavailable",
      "connected sources are not configured",
    );
  let instance = instances.get(state);
  if (!instance) {
    instance = new ComposioSources(state, state.config.composioKey);
    instances.set(state, instance);
  }
  return instance;
}

export async function sourceResult<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error("connected source request failed");
    throw new ApiError(
      "provider_unavailable",
      "connected source is unavailable",
    );
  }
}
