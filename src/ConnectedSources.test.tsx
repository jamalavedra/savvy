import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ConnectedSources from "./ConnectedSources";
import * as api from "./lib/api";
import type { ClientWorkspace, SourceRecord } from "./types";

afterEach(() => vi.restoreAllMocks());

it("connects, searches, and explicitly attaches a record to the current client", async () => {
  const client: ClientWorkspace = {
    id: "client-1",
    name: "Acme",
    folderPath: "/tmp/acme",
    indexStatus: "ready",
    documentCount: 0,
    lastIndexedAt: null,
    activeBriefId: null,
    excludedPaths: [],
    connectedSources: [],
  };
  const record: SourceRecord = {
    provider: "salesforce",
    kind: "account",
    accountId: "account-1",
    recordId: "record-1",
    title: "Acme",
    url: "https://example.test/acme",
    modifiedAt: null,
  };
  const connections = vi
    .spyOn(api, "sourceConnections")
    .mockResolvedValueOnce([
      { provider: "salesforce", accountId: null, connected: false },
    ])
    .mockResolvedValueOnce([
      { provider: "salesforce", accountId: null, connected: false },
    ])
    .mockResolvedValue([
      { provider: "salesforce", accountId: "account-1", connected: true },
    ]);
  const connect = vi.spyOn(api, "sourceConnect").mockResolvedValue();
  const search = vi
    .spyOn(api, "sourceSearch")
    .mockResolvedValue({ records: [record], nextCursor: null });
  const attach = vi.spyOn(api, "attachConnectedSource").mockResolvedValue({
    ...client,
    connectedSources: [
      {
        ...record,
        relativePath: "savvy-source-acme.md",
        contentHash: "hash",
        refreshedAt: "2026-10-16T00:00:00Z",
      },
    ],
  });
  const changed = vi.fn();
  render(
    <ConnectedSources
      client={client}
      disabled={false}
      refreshes={[]}
      onClientChange={changed}
    />,
  );
  await screen.findByRole("button", { name: "Connect" });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(connect).toHaveBeenCalledWith("salesforce"));
  await waitFor(() => expect(connections).toHaveBeenCalledTimes(2));
  fireEvent(window, new Event("focus"));
  await screen.findByRole("button", { name: "Disconnect" });
  fireEvent.change(screen.getByRole("textbox", { name: "Search records" }), {
    target: { value: "Acme" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() =>
    expect(search).toHaveBeenCalledWith(
      "salesforce",
      "account",
      "account-1",
      "Acme",
      undefined,
    ),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Attach" }));
  await waitFor(() => expect(attach).toHaveBeenCalledWith(client.id, record));
  expect(changed).toHaveBeenCalledWith(
    expect.objectContaining({
      id: client.id,
      connectedSources: [
        expect.objectContaining({ recordId: record.recordId }),
      ],
    }),
  );
  expect(connections).toHaveBeenCalled();
});
