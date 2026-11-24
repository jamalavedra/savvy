import assert from "node:assert/strict";

export const ADMIN_TOKEN = "workerd-admin-token-0123456789";

/** Seals a fresh, empty object, which is how a new deployment starts serving. */
export async function sealEmpty(
  fetch: (
    path: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ status: number; text(): Promise<string> }>,
) {
  const response = await fetch("/__admin/seal", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ schema: [], tables: [] }),
  });
  assert.equal(response.status, 200, await response.text());
}
