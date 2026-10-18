import { useEffect, useState } from "react";
import {
  attachConnectedSource,
  removeConnectedSource,
  sourceConnect,
  sourceConnections,
  sourceDisconnect,
  sourceSearch,
  type SourceConnection,
} from "./lib/api";
import type { ClientWorkspace, SourceRecord, SourceRefresh } from "./types";

const providers = [
  ["salesforce", "Salesforce", ["account", "opportunity", "note"]],
  ["hubspot", "HubSpot", ["company", "deal", "note"]],
  ["gong", "Gong", ["call"]],
  ["gmail", "Gmail", ["thread"]],
  ["outlook", "Outlook", ["thread"]],
  ["notion", "Notion", ["page"]],
  ["googledrive", "Google Drive", ["document"]],
] as const;

export default function ConnectedSources({
  client,
  disabled,
  refreshes,
  onClientChange,
}: {
  client: ClientWorkspace;
  disabled: boolean;
  refreshes: SourceRefresh[];
  onClientChange: (client: ClientWorkspace) => void;
}) {
  const [connections, setConnections] = useState<SourceConnection[]>([]);
  const [provider, setProvider] = useState<string>("salesforce");
  const [kind, setKind] = useState<string>("account");
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<SourceRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connection = connections.find((item) => item.provider === provider);
  const availableKinds = providers.find(
    (item) => item[0] === provider,
  )?.[2] ?? ["account"];

  useEffect(() => {
    let mounted = true;
    const reload = () =>
      void sourceConnections()
        .then((items) => {
          if (mounted) setConnections(items);
        })
        .catch((reason) => {
          if (mounted) setError(String(reason));
        });
    reload();
    window.addEventListener("focus", reload);
    return () => {
      mounted = false;
      window.removeEventListener("focus", reload);
    };
  }, []);

  async function run(action: () => Promise<void>) {
    setWorking(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  }
  async function search(next?: string | null) {
    if (!connection?.accountId || !query.trim()) return;
    await run(async () => {
      const result = await sourceSearch(
        provider,
        kind,
        connection.accountId!,
        query.trim(),
        next,
      );
      setRecords(
        next ? (current) => [...current, ...result.records] : result.records,
      );
      setCursor(result.nextCursor);
    });
  }
  const attached = new Set(
    (client.connectedSources ?? []).map(
      (source) =>
        `${source.provider}:${source.kind}:${source.accountId}:${source.recordId}`,
    ),
  );
  return (
    <section className="connected-sources" aria-label="Connected sources">
      <h3>Connected sources</h3>
      <p>
        Connect an app, then choose the records for this client. Savvy saves a
        local Markdown copy.
      </p>
      <div className="connected-source-controls">
        <label>
          App{" "}
          <select
            value={provider}
            disabled={disabled || working}
            onChange={(event) => {
              const next = event.target.value;
              setProvider(next);
              setKind(
                providers.find((item) => item[0] === next)?.[2][0] ?? "account",
              );
              setRecords([]);
              setCursor(null);
            }}
          >
            {providers.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Record type{" "}
          <select
            value={kind}
            disabled={disabled || working}
            onChange={(event) => {
              setKind(event.target.value);
              setRecords([]);
              setCursor(null);
            }}
          >
            {availableKinds.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        {connection?.connected ? (
          <button
            className="button secondary"
            disabled={disabled || working}
            onClick={() =>
              void run(async () => {
                await sourceDisconnect(provider);
                setConnections(await sourceConnections());
                setRecords([]);
              })
            }
          >
            Disconnect
          </button>
        ) : (
          <button
            className="button secondary"
            disabled={disabled || working}
            onClick={() =>
              void run(async () => {
                await sourceConnect(provider);
                setConnections(await sourceConnections());
              })
            }
          >
            Connect
          </button>
        )}
      </div>
      {connection?.status && connection.status !== "DISCONNECTED" && (
        <p role="status">
          Connection: {connection.status.toLowerCase().replace(/_/g, " ")}
        </p>
      )}
      {connection?.connected && (
        <form
          className="connected-source-controls"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <label>
            Search records{" "}
            <input
              value={query}
              maxLength={120}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button
            className="button secondary"
            disabled={disabled || working || !query.trim()}
          >
            Search
          </button>
        </form>
      )}
      {records.length > 0 && (
        <ul className="connected-source-list">
          {records.map((record) => (
            <li key={`${record.provider}:${record.kind}:${record.recordId}`}>
              <span>{record.title}</span>
              <button
                className="button secondary"
                disabled={
                  disabled ||
                  working ||
                  attached.has(
                    `${record.provider}:${record.kind}:${record.accountId}:${record.recordId}`,
                  )
                }
                onClick={() =>
                  void run(async () =>
                    onClientChange(
                      await attachConnectedSource(client.id, record),
                    ),
                  )
                }
              >
                {attached.has(
                  `${record.provider}:${record.kind}:${record.accountId}:${record.recordId}`,
                )
                  ? "Attached"
                  : "Attach"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <button
          className="button secondary"
          disabled={disabled || working}
          onClick={() => void search(cursor)}
        >
          More results
        </button>
      )}
      {(client.connectedSources ?? []).length > 0 && (
        <>
          <h4>Selected for this client</h4>
          <p>
            Removing a selection stops refreshes. Its local copy stays in the
            client folder and can still be cited until you remove the file.
          </p>
          <ul className="connected-source-list">
            {(client.connectedSources ?? []).map((source) => {
              const status = refreshes.find(
                (item) =>
                  item.provider === source.provider &&
                  item.kind === source.kind &&
                  item.accountId === source.accountId &&
                  item.recordId === source.recordId,
              );
              return (
                <li
                  key={`${source.provider}:${source.kind}:${source.accountId}:${source.recordId}`}
                >
                  <span>
                    {source.title}{" "}
                    <small>
                      {source.provider} ·{" "}
                      {status
                        ? `${status.status} ${status.refreshedAt ? new Date(status.refreshedAt).toLocaleString() : "never refreshed"}`
                        : source.refreshedAt
                          ? `Refreshed ${new Date(source.refreshedAt).toLocaleString()}`
                          : "Not refreshed"}
                    </small>
                    {status?.error && (
                      <small role="alert">{status.error}</small>
                    )}
                  </span>
                  <button
                    className="button secondary"
                    disabled={disabled || working}
                    onClick={() =>
                      void run(async () =>
                        onClientChange(
                          await removeConnectedSource(client.id, source),
                        ),
                      )
                    }
                  >
                    Remove selection
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
