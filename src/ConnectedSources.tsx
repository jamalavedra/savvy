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
  ["one_drive", "OneDrive", ["document"]],
  ["microsoft_teams", "Microsoft Teams", ["chat"]],
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
  const [connectUrl, setConnectUrl] = useState("");
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
      {!connection?.connected && provider === "gmail" && (
        <p>
          Google currently asks to let Composio send and permanently delete all
          Gmail messages and read contacts and profile data. Savvy only reads
          threads you select.
        </p>
      )}
      {!connection?.connected && provider === "googledrive" && (
        <p>
          Google currently asks to let Composio edit and delete all Drive files.
          Savvy only reads documents you select.
        </p>
      )}
      {!connection?.connected && provider === "outlook" && (
        <p>
          Microsoft currently asks to let Composio send and delete mail and edit
          calendars, contacts, and mailbox settings. Savvy only reads threads
          you select.
        </p>
      )}
      {!connection?.connected && provider === "one_drive" && (
        <p>
          Microsoft currently asks to let Composio read and write all your
          OneDrive files. Savvy only reads documents you select.
        </p>
      )}
      {!connection?.connected && provider === "microsoft_teams" && (
        <p>
          Microsoft currently asks to let Composio read and write chats. Savvy
          only reads the chats you select.
        </p>
      )}
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
              setConnectUrl("");
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
                setConnectUrl("");
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
                setConnectUrl(await sourceConnect(provider));
                setConnections(await sourceConnections());
              })
            }
          >
            Connect
          </button>
        )}
      </div>
      {connectUrl && !connection?.connected && (
        <details>
          <summary>Browser didn’t open?</summary>
          <label>
            Copy this connection link into your browser
            <input
              aria-label="Connection link"
              readOnly
              value={connectUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
        </details>
      )}
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
                      <small role="alert">
                        {status.error.startsWith("sign_in_required:")
                          ? "This selection belongs to a disconnected account. Reconnect the app, search and attach the record again, then remove this selection."
                          : status.error}
                      </small>
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
