import { DurableObject } from "cloudflare:workers";
import { handleAsNodeRequest } from "cloudflare:node";
import { createServer, type RequestListener } from "node:http";
import { createAuth } from "../src/auth.ts";
import { configuration, systemClock } from "../src/config.ts";
import { migrateService } from "../src/db.ts";
import { DoSqlite } from "../src/do-sqlite.ts";
import { migrate } from "../src/migrate.ts";
import { createHandler, createState, recover } from "../src/app.ts";
import { pruneResults } from "../src/advice.ts";
import { reconcile } from "../src/stripe.ts";
import { expireStaleSessions } from "../src/sessions.ts";
import type { ServiceState } from "../src/state.ts";
import { createAudio, isAudioUpgrade } from "./audio.ts";
import { admin, ADMIN_PREFIX, SEALED } from "./admin.ts";

const PORT = 8788;
const ACTIVE_TICK_MS = 1000;
const IDLE_TICK_MS = 60_000;
const RECONCILE_MS = 60_000;

// One server per isolate: a server created inside an instance fails with
// EADDRINUSE after a reset and cannot do I/O for a later instance.
let listener: RequestListener | undefined;
createServer((req, res) => listener?.(req, res)).listen(PORT);

function stringVars(env: object): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === "string"),
  );
}

export class SavvyBackend extends DurableObject<Env> {
  state!: ServiceState;
  auth!: ReturnType<typeof createAuth>;
  #handle!: RequestListener;
  #audio!: (request: Request) => Promise<Response>;
  #reconciling: Promise<void> | null = null;
  #reconciledAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      if (await ctx.storage.get(SEALED)) await this.#boot();
    });
  }

  async #boot() {
    const vars = stringVars(this.env);
    const config = configuration(vars);
    const service = new DoSqlite(this.ctx.storage).defaultSafeIntegers(true);
    const auth = createAuth(vars, new DoSqlite(this.ctx.storage));
    this.auth = auth;
    await migrate(auth);
    migrateService(service);
    this.state = createState(config, service, systemClock(), auth, () =>
      Promise.reject(new Error("Invitation delivery is not configured")),
    );
    recover(this.state);
    this.#audio = createAudio(this.state, (url, init) =>
      this.supplierFetch(url, init),
    );
    this.#handle = createHandler(this.state, auth, {
      trustsPeer: () => true,
      proxyIpHeader: "x-savvy-proxy-ip",
      authBase: config.issuer,
      google: Boolean(vars.GOOGLE_CLIENT_ID && vars.GOOGLE_CLIENT_SECRET),
      email: false,
      readUi: (path) => this.#readUi(path),
    });
    await this.#arm();
  }

  protected supplierFetch(url: string, init: RequestInit) {
    return fetch(url, init);
  }

  async #readUi(path: string) {
    const response = await this.env.ASSETS.fetch(`https://assets${path}`);
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(`Static asset ${path} answered ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  #cadence() {
    const live = this.state.db
      .prepare("SELECT 1 FROM managed_sessions WHERE state='active' LIMIT 1")
      .get();
    return live ? ACTIVE_TICK_MS : IDLE_TICK_MS;
  }

  async #arm() {
    const next = Date.now() + this.#cadence();
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next)
      await this.ctx.storage.setAlarm(next);
  }

  override async fetch(request: Request) {
    if (new URL(request.url).pathname.startsWith(ADMIN_PREFIX))
      return admin(
        {
          storage: this.ctx.storage,
          token: (this.env as { ADMIN_TOKEN?: string }).ADMIN_TOKEN,
          bucket: (this.env as { BACKUPS?: R2Bucket }).BACKUPS,
          blockConcurrencyWhile: (fn) => this.ctx.blockConcurrencyWhile(fn),
          sealed: () => this.ctx.blockConcurrencyWhile(() => this.#boot()),
        },
        request,
      );
    if (!this.state)
      return Response.json(
        {
          error: "import_pending",
          message:
            "This backend is not sealed yet: an import is pending or has not started",
        },
        { status: 503, headers: { "retry-after": "60" } },
      );
    listener = this.#handle;
    const response = isAudioUpgrade(request)
      ? await this.#audio(request)
      : await handleAsNodeRequest(PORT, request);
    await this.#arm();
    return response;
  }

  override async alarm() {
    if (!this.state) return;
    try {
      if (!this.#reconciling && Date.now() - this.#reconciledAt >= RECONCILE_MS)
        this.#reconcile();
      expireStaleSessions(this.state);
      pruneResults(this.state);
    } catch (error) {
      console.error(
        "maintenance tick failed; retrying on the next alarm",
        error,
      );
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + this.#cadence());
    }
  }

  #reconcile() {
    this.#reconciledAt = Date.now();
    this.#reconciling = reconcile(this.state)
      .catch((error) => console.error("billing reconcile failed", error))
      .finally(() => {
        this.#reconciling = null;
      });
  }
}
