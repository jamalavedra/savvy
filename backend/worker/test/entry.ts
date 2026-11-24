import { setTimeout as sleep } from "node:timers/promises";
import worker, { SavvyBackend as Backend } from "../index.ts";
import { onAudio } from "../../src/sessions.ts";

const PROBE = "/__probe/";
const FRAME_MS = 100;

// The production object plus probes the tests use to mint tokens, read the
// alarm and deliver audio until CF-4 brings the WebSocket relay.
export class SavvyBackend extends Backend {
  override async fetch(request: Request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PROBE)) return super.fetch(request);
    const probe = url.pathname.slice(PROBE.length);
    const query = url.searchParams;
    if (probe === "token") {
      const { token } = await this.auth.auth.api.signJWT({
        body: {
          payload: {
            sub: query.get("sub") ?? "probe-user",
            aud: this.state.config.audience,
            exp: Math.floor(Date.now() / 1000) + 300,
          },
        },
      });
      return new Response(token);
    }
    if (probe === "alarm") {
      const alarm = await this.ctx.storage.getAlarm();
      return Response.json({
        id: this.ctx.id.toString(),
        inMs: alarm === null ? null : alarm - Date.now(),
      });
    }
    if (probe === "clear-alarm") {
      await this.ctx.storage.deleteAlarm();
      return Response.json(null);
    }
    if (probe === "fire") {
      await this.ctx.storage.setAlarm(Date.now());
      return Response.json(null);
    }
    if (probe === "audio") {
      await this.#audio(query);
      return Response.json(null);
    }
    return new Response(`unknown probe ${probe}`, { status: 404 });
  }

  async #audio(query: URLSearchParams) {
    const id = query.get("session")!;
    const { account_id } = this.state.db
      .prepare<[string], { account_id: bigint }>(
        "SELECT account_id FROM managed_sessions WHERE local_session_id=?",
      )
      .get(id)!;
    for (let ms = 0; ms < Number(query.get("ms")); ms += FRAME_MS) {
      onAudio(
        this.state,
        account_id,
        id,
        "microphone",
        FRAME_MS * 32,
        this.state.clock(),
      );
      await sleep(FRAME_MS);
    }
  }
}

// Local workerd throws on jurisdiction(), so the probe entry hands the Worker
// a namespace whose eu subnamespace is the plain one.
export default {
  fetch(request, env) {
    if (new URL(request.url).pathname.startsWith(PROBE))
      return env.BACKEND.getByName("primary").fetch(request);
    const BACKEND = {
      jurisdiction: () => env.BACKEND,
    } as unknown as Env["BACKEND"];
    return worker.fetch(request, { ...env, BACKEND });
  },
} satisfies ExportedHandler<Env>;
