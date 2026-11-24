import { setTimeout as sleep } from "node:timers/promises";
import { DurableObject } from "cloudflare:workers";
import worker, { SavvyBackend as Backend } from "../index.ts";

const PROBE = "/__probe/";
const DEEPGRAM = "/__deepgram/";

type TestEnv = Env & { DEEPGRAM: DurableObjectNamespace };

// The production object plus probes the tests use to mint tokens, read the
// alarm, hold a Better Auth transaction and reset the object.
export class SavvyBackend extends Backend {
  protected override supplierFetch(url: string, init: RequestInit) {
    const fake = (this.env as TestEnv).DEEPGRAM.getByName("fake");
    return fake.fetch(url, init);
  }

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
    if (probe === "reset") this.ctx.abort("reset by the test harness");
    if (probe === "hold-auth") {
      await this.#holdAuth(Number(query.get("ms")));
      return Response.json(null);
    }
    return new Response(`unknown probe ${probe}`, { status: 404 });
  }

  async #holdAuth(ms: number) {
    const context = await this.auth.auth.$context;
    await context.adapter
      .transaction(async (trx) => {
        await trx.create({
          model: "verification",
          data: {
            identifier: "held",
            value: "v",
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        await sleep(ms);
        throw new Error("held sign-in rolled back");
      })
      .catch(() => {});
  }
}

// Speaks the slice of the Deepgram live protocol the relay uses: a Results
// message per audio frame whose start and duration track the audio received.
// "stall" stops answering, even close frames; "hang" never completes the
// upgrade; "close" drops every open supplier socket.
export class FakeDeepgram extends DurableObject {
  stall = false;
  hang = false;
  closeCodes: number[] = [];
  connections = 0;
  forwarded = 0;
  requests: { authorization: string | null; query: string }[] = [];
  sockets = new Set<WebSocket>();

  override async fetch(request: Request) {
    const action = new URL(request.url).pathname.slice(DEEPGRAM.length);
    if (action === "stall") this.stall = true;
    if (action === "hang") this.hang = true;
    if (action === "reset") {
      this.stall = this.hang = false;
      this.connections = this.forwarded = 0;
      this.requests = [];
      this.closeCodes = [];
    }
    if (action === "close")
      for (const socket of this.sockets) socket.close(1011);
    if (request.headers.get("upgrade") !== "websocket")
      return Response.json({
        connections: this.connections,
        forwarded: this.forwarded,
        open: this.sockets.size,
        requests: this.requests,
        closeCodes: this.closeCodes,
      });
    const url = new URL(request.url);
    this.connections++;
    this.requests.push({
      authorization: request.headers.get("authorization"),
      query: url.search,
    });
    if (this.hang) await sleep(30_000);
    const [client, server] = Object.values(new WebSocketPair());
    server!.accept({ allowHalfOpen: true });
    server!.binaryType = "arraybuffer";
    this.sockets.add(server!);
    let received = 0;
    server!.addEventListener("message", ({ data }) => {
      if (typeof data === "string") return;
      const size = (data as ArrayBuffer).byteLength;
      this.forwarded += size;
      if (this.stall) return;
      server!.send(
        JSON.stringify({
          type: "Results",
          start: received / 32_000,
          duration: size / 32_000,
          is_final: true,
          speech_final: true,
          metadata: { secret: "must disappear" },
          channel: {
            alternatives: [
              {
                transcript: "Synthetic transcript",
                confidence: 0.9,
                words: [],
              },
            ],
          },
        }),
      );
      received += size;
    });
    server!.addEventListener("close", ({ code }) => {
      this.closeCodes.push(code);
      this.sockets.delete(server!);
      if (!this.stall) server!.close();
    });
    server!.addEventListener("error", () => this.sockets.delete(server!));
    return new Response(null, { status: 101, webSocket: client });
  }
}

// Local workerd throws on jurisdiction(), so the probe entry hands the Worker
// a namespace whose eu subnamespace is the plain one.
export default {
  fetch(request, env) {
    if (new URL(request.url).pathname.startsWith(DEEPGRAM))
      return env.DEEPGRAM.getByName("fake").fetch(request);
    if (new URL(request.url).pathname.startsWith(PROBE))
      return env.BACKEND.getByName("primary").fetch(request);
    const BACKEND = {
      jurisdiction: () => env.BACKEND,
    } as unknown as Env["BACKEND"];
    return worker.fetch(request, { ...env, BACKEND });
  },
} satisfies ExportedHandler<TestEnv>;
