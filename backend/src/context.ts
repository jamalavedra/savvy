import { z } from "zod";
import { readFileSync } from "node:fs";
import { validateSessionId } from "./sessions.js";
import { ApiError } from "./errors.js";

export const contracts = JSON.parse(
  readFileSync(new URL("./provider-contracts.json", import.meta.url), "utf8"),
) as {
  briefSchema: Record<string, unknown>;
  adviceSchema: Record<string, unknown>;
  briefPrompt: string;
  advicePrompt: string;
  actionRules: { manual: string; opportunity: string; other: string };
};
const uint = z.number().int().nonnegative();
const uuid = z.string().transform((value, ctx) => {
  try {
    if (value !== value.trim()) throw new Error();
    return validateSessionId(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "invalid UUID" });
    return z.NEVER;
  }
});
const optionalUint = uint
  .max(4_294_967_295)
  .nullish()
  .transform((v) => v ?? null);
const optionalString = z
  .string()
  .nullish()
  .transform((v) => v ?? null);
const strings = z.array(z.string());
const locator = z.object({
  label: z.string(),
  page: optionalUint,
  slide: optionalUint,
  sheet: optionalString,
  rowStart: optionalUint,
  rowEnd: optionalUint,
  chapter: optionalString,
  heading: optionalString,
  lineStart: optionalUint,
  lineEnd: optionalUint,
});
const briefEvidence = z.object({
  sourceId: uuid,
  relativePath: z.string(),
  locator,
  text: z.string(),
});
export const briefRequest = z.object({
  clientName: z.string(),
  instructions: z.string(),
  guidance: z.array(briefEvidence),
  clientEvidence: z.array(briefEvidence),
});
const ledgerItem = z.object({
  kind: z.enum([
    "decision",
    "objection",
    "question",
    "commitment",
    "constraint",
    "concession",
  ]),
  text: z.string(),
  sourceTurnIds: z.array(uuid),
});
const turn = z.object({
  id: uuid,
  sessionId: uuid,
  channel: z.enum(["selfSpeaker", "other", "unknown"]),
  text: z.string(),
  language: z.string().max(64),
  startMs: uint,
  endMs: uint,
  isFinal: z.boolean(),
  confidence: z.number(),
});
export const adviceRequest = z.object({
  sessionId: uuid,
  generationId: uint,
  transcriptRevision: uint,
  trigger: z.enum([
    "question",
    "objection",
    "commitment",
    "decision",
    "risk",
    "opportunity",
    "manual",
  ]),
  language: z.string().max(64),
  briefMarkdown: z.string(),
  hardConstraints: strings,
  evidence: z.array(
    z.object({
      id: uuid,
      kind: z.enum(["guideline", "client", "brief"]),
      relativePath: z.string(),
      locator,
      excerpt: z.string(),
    }),
  ),
  meetingLedger: z.object({ items: z.array(ledgerItem) }),
  recentTurns: z.array(turn),
  focalTurnIds: z.array(uuid),
});
export const briefOutput = z.object({
  title: z.string(),
  objective: z.string(),
  responseLanguage: z.string(),
  ourPosition: z.string(),
  clientPosition: z.string(),
  priorities: strings,
  agenda: z.array(
    z.object({
      title: z.string(),
      objective: z.string(),
      talkingPoints: strings,
      keywords: strings,
    }),
  ),
  desiredOutcomes: strings,
  questionsToAsk: strings,
  factsToUse: z.array(z.object({ statement: z.string(), sourceIds: strings })),
  concessions: z.array(
    z.object({
      item: z.string(),
      condition: z.string(),
      requiresApproval: z.boolean(),
    }),
  ),
  redLines: strings,
  prohibitedClaims: strings,
  unauthorizedCommitments: strings,
  risks: strings,
});
export const adviceOutput = z.object({
  action: z.string(),
  say: z.string(),
  avoid: z.string(),
  rationale: z.string(),
  language: z.string(),
  evidenceIds: z.array(uuid),
  turnIds: z.array(uuid),
  memoryUpdates: z.array(ledgerItem),
  validForMs: uint,
});
export type BriefRequest = z.infer<typeof briefRequest>;
export type AdviceRequest = z.infer<typeof adviceRequest>;
export type GeneratedBrief = z.infer<typeof briefOutput>;
export type ProviderAdvice = z.infer<typeof adviceOutput>;

export function safeRelativePath(path: string) {
  return (
    !/^[\\/]/.test(path) &&
    Buffer.from(path)[1] !== 58 &&
    !path.split(/[\\/]/).includes("..")
  );
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  return value;
}
function format(template: string, values: string[], action = "") {
  let index = 0;
  return template.replace(/\{\}|\{action_rule\}/g, (match) =>
    match === "{action_rule}" ? action : values[index++],
  );
}
export function briefPrompt(request: BriefRequest) {
  return format(contracts.briefPrompt, [
    JSON.stringify(request.clientName),
    JSON.stringify(request.instructions.trim()),
    JSON.stringify(sorted(request.guidance)),
    JSON.stringify(sorted(request.clientEvidence)),
  ]);
}
export function advicePrompt(request: AdviceRequest) {
  const context = {
    trigger: request.trigger,
    hardConstraints: request.hardConstraints,
    meetingBrief: request.briefMarkdown,
    evidence: request.evidence,
    meetingLedger: request.meetingLedger,
    recentTranscript: request.recentTurns,
    focalTurnIds: request.focalTurnIds,
  };
  const rule =
    request.trigger === "manual"
      ? contracts.actionRules.manual
      : request.trigger === "opportunity"
        ? contracts.actionRules.opportunity
        : contracts.actionRules.other;
  return format(
    contracts.advicePrompt,
    [request.language, request.language, JSON.stringify(context)],
    rule,
  );
}
export function validateBrief(
  value: unknown,
  request: BriefRequest,
): GeneratedBrief {
  const parsed = briefOutput.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      "result_unavailable",
      "reasoning provider returned invalid JSON",
    );
  const brief = parsed.data;
  if (
    Buffer.byteLength(JSON.stringify(brief)) > 65_536 ||
    brief.agenda.length > 20 ||
    !brief.title.trim() ||
    !brief.objective.trim() ||
    !brief.agenda.length ||
    !brief.responseLanguage.trim()
  )
    throw new ApiError("result_unavailable", "incomplete brief");
  for (const fact of brief.factsToUse)
    if (
      !fact.statement.trim() ||
      !fact.sourceIds.length ||
      fact.sourceIds.some(
        (id) => !request.clientEvidence.some((e) => e.sourceId === id),
      )
    )
      throw new ApiError(
        "result_unavailable",
        "brief cites evidence that was not provided",
      );
  return brief;
}
export function validateAdvice(
  value: unknown,
  request: AdviceRequest,
): ProviderAdvice {
  const parsed = adviceOutput.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      "result_unavailable",
      "reasoning provider returned invalid JSON",
    );
  const advice = parsed.data;
  const textFits = (text: string, characters: number) =>
    Buffer.byteLength(text) <= characters * 4 &&
    Array.from(text).length <= characters;
  const idsFit = (ids: string[]) =>
    ids.length <= 32 && new Set(ids).size === ids.length;
  if (
    !textFits(advice.say, 1024) ||
    !textFits(advice.avoid, 512) ||
    !textFits(advice.rationale, 512) ||
    !textFits(advice.language, 64) ||
    !idsFit(advice.evidenceIds) ||
    !idsFit(advice.turnIds) ||
    advice.memoryUpdates.length > 8 ||
    advice.memoryUpdates.some(
      (item) => !textFits(item.text, 512) || !idsFit(item.sourceTurnIds),
    ) ||
    Buffer.byteLength(JSON.stringify(advice)) > 65536
  )
    throw new ApiError(
      "result_unavailable",
      "provider advice exceeds output limits",
    );
  const knownTurn = (id: string) =>
    request.recentTurns.some((t) => t.id === id);
  const words = (s: string) => s.match(/\S+/gu)?.length ?? 0;
  if (
    (request.trigger === "manual" && advice.action !== "show") ||
    !["show", "skip"].includes(advice.action) ||
    advice.language !== request.language ||
    advice.validForMs < 1000 ||
    advice.validForMs > 120000 ||
    advice.evidenceIds.some(
      (id) => !request.evidence.some((e) => e.id === id),
    ) ||
    advice.turnIds.some((id) => !knownTurn(id)) ||
    advice.memoryUpdates.some(
      (m) =>
        !m.sourceTurnIds.length || m.sourceTurnIds.some((id) => !knownTurn(id)),
    ) ||
    (advice.action === "show" &&
      request.trigger === "opportunity" &&
      !advice.turnIds.some((id) => request.focalTurnIds.includes(id))) ||
    words(advice.avoid) >= 35 ||
    words(advice.rationale) >= 35 ||
    (advice.action === "show" &&
      (!advice.say.trim() ||
        words(advice.say) >= 60 ||
        (!advice.evidenceIds.length && !advice.turnIds.length)))
  )
    throw new ApiError(
      "result_unavailable",
      "advice failed language, grounding, or output validation",
    );
  return advice;
}
