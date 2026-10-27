import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Authorizer } from "./authorize.js";
import type { LiveSession } from "./sessions.js";
import { ApiError } from "./errors.js";

import { assertFundingCapability } from "./capability.js";

export interface ServiceBindings {
  authorizeBrowser?: Authorizer;
  sendInvitation?: (email: string, link: string) => Promise<void>;
}

export class ServiceState {
  draining = false;
  aiPaused = false;
  readonly aiInFlight = new Set<bigint>();
  readonly aiHealth: {
    failures: bigint[];
    blockedUntil: bigint | null;
    probe: Promise<void> | null;
  } = { failures: [], blockedUntil: null, probe: null };
  readonly briefResults = new Map<
    bigint,
    Map<string, { at: bigint; value: unknown }>
  >();
  readonly billingInFlight = new Set<string>();
  billingCalls = 0;
  readonly sessions = new Map<bigint, LiveSession>();
  readonly cancellations = new Map<
    bigint,
    Map<
      string,
      {
        controller: AbortController;
        fundingAssignmentId: bigint | null;
        sessionId: bigint | null;
      }
    >
  >();
  constructor(
    readonly config: Config,
    readonly db: Db,
    readonly clock: () => bigint,
    readonly authorize: Authorizer,
    readonly bindings: ServiceBindings = {},
  ) {
    assertFundingCapability(db);
  }
  requireAdmission() {
    if (this.draining)
      throw new ApiError(
        "provider_unavailable",
        "managed service is draining; local data and BYOK remain available",
      );
  }
  requireAssistance() {
    this.requireAdmission();
    if (this.aiPaused)
      throw new ApiError(
        "provider_unavailable",
        "reasoning provider is unavailable",
      );
  }
}
