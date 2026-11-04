const statuses = {
  sign_in_required: 401,
  funding_unavailable: 409,
  funding_mismatch: 409,
  no_seat: 403,
  checkout_mismatch: 409,
  team_purchase_disabled: 403,
  payment_pending: 402,
  quota_exhausted: 402,
  session_conflict: 409,
  session_ended: 410,
  context_too_large: 413,
  rate_limited: 429,
  provider_unavailable: 503,
  result_unavailable: 410,
  invalid_request: 400,
  purchase_rejected: 400,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof statuses;

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryAfterMs?: bigint,
    status?: number,
  ) {
    super(message);
    this.status = status ?? statuses[code];
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: this.retryAfterMs }),
    };
  }
}

/** Reject precision loss at the JSON boundary; SQLite and ledgers use BigInt. */
export function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "bigint") return item;
    const number = Number(item);
    if (!Number.isSafeInteger(number))
      throw new ApiError("internal", "the service hit an internal error");
    return number;
  });
}

/** Reads a supplier response body, cancelling it and throwing `tooLarge` past `limit` bytes. */
export async function readLimited(
  response: Response,
  limit: number,
  tooLarge: ApiError,
): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw tooLarge;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
