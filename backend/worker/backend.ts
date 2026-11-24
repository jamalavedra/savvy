import { DurableObject } from "cloudflare:workers";
import { handleAsNodeRequest } from "cloudflare:node";
import { createServer, type RequestListener } from "node:http";
import { createAuth, invitationSender, type MailSender } from "../src/auth.ts";
import { configuration, systemClock } from "../src/config.ts";
import { migrateService } from "../src/db.ts";
import { DoSqlite } from "../src/do-sqlite.ts";
import { migrate } from "../src/migrate.ts";
import { createHandler, createState, recover } from "../src/app.ts";
import { pruneResults } from "../src/advice.ts";
import { reconcile } from "../src/stripe.ts";
import { expireStaleSessions } from "../src/sessions.ts";
import { noteError } from "../src/recent-errors.ts";
import type { ServiceState } from "../src/state.ts";
import { createAudio, isAudioUpgrade } from "./audio.ts";
import { admin, ADMIN_PREFIX, LAST_ALARM, SEALED } from "./admin.ts";

const PORT = 8788;
const ACTIVE_TICK_MS = 1000;
const IDLE_TICK_MS = 60_000;
const RECONCILE_MS = 60_000;

// One server per isolate: a server created inside an instance fails with
// EADDRINUSE after a reset and cannot do I/O for a later instance.
let listener: RequestListener | undefined;
createServer((req, res) => listener?.(req, res)).listen(PORT);

function stringVars(env: object) {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === "string"),
  ) as NodeJS.ProcessEnv;
}

function emailService(env: {
  EMAIL?: SendEmail;
  SAVVY_EMAIL_FROM?: string;
}): MailSender | null {
  const { EMAIL: binding, SAVVY_EMAIL_FROM: from } = env;
  if (!binding || !from) return null;
  return {
    async send(message) {
      await binding.send({ from, ...message });
    },
  };
}

export class SavvyBackend extends DurableObject<Env> {
  state!: ServiceState;
  auth!: ReturnType<typeof createAuth>;
  #handle!: RequestListener;
  #audio!: (request: Request) => Promise<Response>;
  #reconciling: Promise<void> | null = null;
  #reconciledAt = 0;
  #frozen = false;

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
    const mail = emailService(this.env);
    const auth = createAuth(vars, new DoSqlite(this.ctx.storage), mail);
    this.auth = auth;
    await migrate(auth);
    migrateService(service);
    this.state = createState(
      config,
      service,
      systemClock(),
      auth,
      invitationSender(mail),
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
      email: Boolean(mail),
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

  #reset() {
    this.ctx.abort("Frozen by the admin; retry on the fresh instance");
  }

  override async fetch(request: Request) {
    if (this.#frozen) this.#reset();
    if (new URL(request.url).pathname.startsWith(ADMIN_PREFIX))
      return admin(
        {
          storage: this.ctx.storage,
          token: (this.env as { ADMIN_TOKEN?: string }).ADMIN_TOKEN,
          bucket: (this.env as { BACKUPS?: R2Bucket }).BACKUPS,
          blockConcurrencyWhile: (fn) => this.ctx.blockConcurrencyWhile(fn),
          sealed: () => this.ctx.blockConcurrencyWhile(() => this.#boot()),
          frozen: () => {
            this.#frozen = true;
            setTimeout(() => this.#reset(), 0);
          },
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
    if (this.#frozen) this.#reset();
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
      await this.ctx.storage.put(LAST_ALARM, Date.now());
    }
  }

  #reconcile() {
    this.#reconciledAt = Date.now();
    this.#reconciling = reconcile(this.state)
      .catch((error) => {
        console.error("billing reconcile failed", error);
        noteError("reconcile_failures_5m");
      })
      .finally(() => {
        this.#reconciling = null;
      });
  }
}
