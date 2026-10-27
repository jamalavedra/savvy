import { z } from "zod";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";

export const entityId = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine(
    (value) =>
      /^[1-9][0-9]{0,18}$/.test(value) &&
      BigInt(value) <= 9_223_372_036_854_775_807n,
  );
export const fundingChoice = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal") }).strict(),
  z
    .object({ kind: z.literal("organization"), organizationId: entityId })
    .strict(),
]);
export type FundingChoice = z.infer<typeof fundingChoice>;
export type FundingContext =
  | { kind: "personal" }
  | {
      kind: "organization";
      organizationId: bigint;
      assignmentId: bigint;
    };
export const PERSONAL = { kind: "personal" } as const;
export interface FundingRow {
  funding_scope: "personal" | "organization";
  funding_assignment_id: bigint | null;
}

export function scopeFilter(context: FundingContext) {
  return context.kind === "personal"
    ? {
        sql: "kind<>'seat' AND seat_assignment_id IS NULL AND seat_period_id IS NULL",
        params: [] as bigint[],
      }
    : {
        sql: `kind='seat' AND seat_assignment_id=? AND EXISTS(
          SELECT 1 FROM seat_periods p JOIN seat_assignments a ON a.seat_id=p.seat_id
          WHERE p.id=allowance_grants.seat_period_id AND p.organization_id=?
            AND a.id=allowance_grants.seat_assignment_id AND p.financial_status='paid')`,
        params: [context.assignmentId, context.organizationId],
      };
}

export function fundingForRow(
  db: Db,
  account: bigint,
  row: FundingRow,
): FundingContext {
  if (row.funding_scope === "personal" && row.funding_assignment_id === null)
    return PERSONAL;
  const assignment = db
    .prepare<[bigint, bigint | null], { organization_id: bigint }>(
      `SELECT s.organization_id FROM seat_assignments a JOIN seats s ON s.id=a.seat_id
     WHERE a.account_id=? AND a.id=?`,
    )
    .get(account, row.funding_assignment_id);
  if (row.funding_scope !== "organization" || !assignment)
    throw new ApiError(
      "no_seat",
      "the original seat assignment is unavailable",
    );
  return {
    kind: "organization",
    organizationId: assignment.organization_id,
    assignmentId: row.funding_assignment_id!,
  };
}

export function assertFunding(
  db: Db,
  account: bigint,
  context: FundingContext,
  now: bigint,
) {
  if (context.kind === "personal") return;
  const eligible = db
    .prepare(
      `SELECT 1 FROM seat_assignments a JOIN seats s ON s.id=a.seat_id
     JOIN organization_members m ON m.organization_id=s.organization_id AND m.account_id=a.account_id
     JOIN accounts actor ON actor.id=a.account_id
     WHERE a.id=? AND a.account_id=? AND s.organization_id=? AND a.ended_at_ms IS NULL
       AND s.status IN ('active','retiring') AND actor.disabled=0
       AND EXISTS(SELECT 1 FROM seat_periods p WHERE p.seat_id=s.id
         AND p.organization_id=s.organization_id AND p.financial_status='paid' AND p.starts_ms<=? AND p.ends_ms>?)`,
    )
    .get(context.assignmentId, account, context.organizationId, now, now);
  if (!eligible)
    throw new ApiError(
      "no_seat",
      "your organization seat is no longer available; choose personal funding explicitly to use personal credit",
    );
}

export function assertFundingChoice(
  context: FundingContext,
  choice: FundingChoice = PERSONAL,
) {
  if (
    context.kind !== choice.kind ||
    (context.kind === "organization" &&
      choice.kind === "organization" &&
      context.organizationId.toString() !== choice.organizationId)
  )
    throw new ApiError(
      "funding_mismatch",
      "this request is already bound to a different payer",
    );
}
