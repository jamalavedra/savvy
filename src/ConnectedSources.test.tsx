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
  const connect = vi
    .spyOn(api, "sourceConnect")
    .mockResolvedValue("https://connect.example.test/link");
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
  expect(await screen.findByLabelText("Connection link")).toHaveValue(
    "https://connect.example.test/link",
  );
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
  fireEvent.click(await screen.findByRole("button", { name: "Attach Acme" }));
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

it("explains how to replace a selection after reconnecting", async () => {
  vi.spyOn(api, "sourceConnections").mockResolvedValue([
    { provider: "notion", accountId: "new-account", connected: true },
  ]);
  render(
    <ConnectedSources
      client={{
        id: "client-1",
        name: "Acme",
        folderPath: "/tmp/acme",
        indexStatus: "ready",
        documentCount: 1,
        lastIndexedAt: null,
        activeBriefId: null,
        excludedPaths: [],
        connectedSources: [
          {
            provider: "notion",
            kind: "page",
            accountId: "old-account",
            recordId: "page-1",
            title: "Acme page",
            url: "https://notion.so/page-1",
            modifiedAt: null,
            relativePath: "savvy-source-notion-old.md",
            contentHash: "hash",
            refreshedAt: "2026-10-18T00:00:00Z",
          },
        ],
      }}
      disabled={false}
      refreshes={[
        {
          provider: "notion",
          kind: "page",
          accountId: "old-account",
          recordId: "page-1",
          title: "Acme page",
          relativePath: "savvy-source-notion-old.md",
          status: "failed",
          refreshedAt: "2026-10-18T00:00:00Z",
          error: "sign_in_required: connected account is no longer available",
        },
      ]}
      onClientChange={vi.fn()}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "search and attach the record again",
  );
});

it("blocks repeated and disabled form submissions and announces empty searches", async () => {
  vi.spyOn(api, "sourceConnections").mockResolvedValue([
    { provider: "salesforce", accountId: "account-1", connected: true },
  ]);
  let finish!: (result: { records: SourceRecord[]; nextCursor: null }) => void;
  const search = vi.spyOn(api, "sourceSearch").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const props = {
    client: {
      id: "client-1",
      name: "Acme",
      folderPath: "/tmp/acme",
      indexStatus: "ready",
      documentCount: 0,
      lastIndexedAt: null,
      activeBriefId: null,
      excludedPaths: [],
      connectedSources: [],
    } as ClientWorkspace,
    disabled: false,
    refreshes: [],
    onClientChange: vi.fn(),
  };
  const view = render(<ConnectedSources {...props} />);
  const input = await screen.findByRole("textbox", { name: "Search records" });
  fireEvent.change(input, { target: { value: "Acme" } });
  const form = input.closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(search).toHaveBeenCalledOnce();
  expect(input).toBeDisabled();
  expect(await screen.findByText("Searching records…")).toHaveAttribute(
    "role",
    "status",
  );
  finish({ records: [], nextCursor: null });
  expect(
    await screen.findByText("No records found. Try another search."),
  ).toHaveAttribute("role", "status");
  view.rerender(<ConnectedSources {...props} disabled />);
  expect(input).toBeDisabled();
  fireEvent.submit(form);
  expect(search).toHaveBeenCalledOnce();
});

it("omits Gong from new connections while retaining an existing selection", async () => {
  vi.spyOn(api, "sourceConnections").mockResolvedValue([]);
  const source = {
    provider: "gong",
    kind: "call",
    accountId: "old-account",
    recordId: "call-1",
    title: "Saved Gong call",
    url: "https://app.gong.io/call?id=call-1",
    modifiedAt: null,
    relativePath: "savvy-source-gong-old.md",
    contentHash: "hash",
    refreshedAt: "2026-10-18T00:00:00Z",
  };
  const client: ClientWorkspace = {
    id: "client-1",
    name: "Acme",
    folderPath: "/tmp/acme",
    indexStatus: "ready",
    documentCount: 1,
    lastIndexedAt: null,
    activeBriefId: null,
    excludedPaths: [],
    connectedSources: [source],
  };
  const remove = vi
    .spyOn(api, "removeConnectedSource")
    .mockResolvedValue({ ...client, connectedSources: [] });
  render(
    <ConnectedSources
      client={client}
      disabled={false}
      refreshes={[]}
      onClientChange={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole("option", { name: "Gong" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Saved Gong call")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove selection Saved Gong call" }),
  );
  await waitFor(() => expect(remove).toHaveBeenCalledWith(client.id, source));
});
