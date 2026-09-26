import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getRequest, setResponse } from "better-call/node";
import { isIP } from "node:net";
import { createAuth } from "./auth.js";
import { configuration, systemClock } from "./config.js";
import { openServiceDatabase } from "./db.js";
import { createAuthorizer } from "./authorize.js";
import { ServiceState } from "./state.js";
import { managedRequest } from "./api.js";
import { pruneResults } from "./advice.js";
import { releaseBrief } from "./billing.js";
import { attachAudio } from "./transcription.js";
import { reconcile } from "./stripe.js";
import { recoverRestart, expireStaleSessions } from "./sessions.js";

const config = configuration();
const { auth, db } = createAuth();
const serviceDb = openServiceDatabase(config.serviceDatabase);
const clock = systemClock();
export const state = new ServiceState(
  config,
  serviceDb,
  clock,
  createAuthorizer(
    serviceDb,
    {
      issuer: config.issuer,
      audience: config.audience,
      unmetered: config.billing === null,
    },
    () => auth.api.getJwks(),
    clock,
  ),
);
recoverRestart(state);
serviceDb
  .transaction(() => {
    const rows = serviceDb
      .prepare<[], { account_id: bigint; request_key: string }>(
        "SELECT account_id,request_key FROM provider_requests WHERE state='pending'",
      )
      .all();
    for (const row of rows)
      releaseBrief(serviceDb, row.account_id, row.request_key, clock());
  })
  .immediate();
const trustedProxies = (process.env.SAVVY_AUTH_TRUSTED_PROXIES ?? "")
  .split(",")
  .filter(Boolean);
if (trustedProxies.some((ip) => !isIP(ip)))
  throw new Error("Invalid trusted proxy IP");
const server = createServer(async (req, res) => {
  const originalSetHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    if (
      name.toLowerCase() === "location" &&
      typeof value === "string" &&
      value.startsWith("com.alamaslabs.savvy:/oauth/callback?")
    )
      value = "/complete#" + encodeURIComponent(value);
    return originalSetHeader(name, value);
  };
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );

  try {
    const peer = req.socket.remoteAddress ?? "";
    const forwarded = req.headers["x-savvy-proxy-ip"];
    if (!isIP(peer)) {
      res.writeHead(400).end();
      return;
    }
    if (
      trustedProxies.includes(peer) &&
      (typeof forwarded !== "string" || !isIP(forwarded))
    ) {
      res.writeHead(400).end("Invalid proxy address");
      return;
    }
    req.headers["x-savvy-client-ip"] = trustedProxies.includes(peer)
      ? forwarded
      : peer;
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/readyz" || path.startsWith("/v1/")) {
      if (path === "/readyz") db.prepare("SELECT id FROM jwks LIMIT 1").get();
      return await managedRequest(state, req, res, path);
    }
    if (path.startsWith("/api/auth/") || path.startsWith("/.well-known/")) {
      if (
        req.method !== "GET" &&
        req.method !== "HEAD" &&
        !req.headers["content-type"]
      )
        req.headers["content-type"] = "application/octet-stream";
      const request = getRequest({
        request: req,
        base: process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8788",
        bodySizeLimit: 65_536,
      });
      // Consume the bounded stream before Better Auth can turn parse errors into 400.
      const body = request.body ? await request.arrayBuffer() : undefined;
      return await setResponse(
        res,
        await auth.handler(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body,
          }),
        ),
      );
    }
    if (path === "/ready") {
      db.prepare("SELECT id FROM jwks LIMIT 1").get();
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          status: "ready",
          google: Boolean(
            process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
          ),
          email: Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM),
          billing: config.billing ? "stripe" : "unmetered",
        }),
      );
      return;
    }
    if (path === "/configuration") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          google: Boolean(
            process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
          ),
        }),
      );
      return;
    }
    const asset = /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.exec(path);
    if (
      !asset &&
      !["/", "/sign-in", "/sign-up", "/consent", "/complete"].includes(path)
    ) {
      res.writeHead(404).end();
      return;
    }
    const file = fileURLToPath(
      new URL(asset ? `../dist${path}` : "../dist/index.html", import.meta.url),
    );
    res.setHeader(
      "Content-Type",
      asset
        ? asset[1] === "js"
          ? "text/javascript"
          : "text/css"
        : "text/html",
    );
    res.end(await readFile(file));
  } catch (error) {
    if (
      error instanceof Error &&
      /content-length|body size exceeded/.test(error.message)
    ) {
      res.setHeader("Connection", "close");
      res.writeHead(413).end("Request body exceeds 65536 bytes");
      req.pause();
      return;
    }
    res.writeHead(503).end("Savvy sign-in is unavailable. Try again later.");
  }
});
const closeAudio = attachAudio(server, state);
server.listen(config.port, config.bind);
let maintenanceTimer: ReturnType<typeof setTimeout>;
let maintenance: Promise<void>;
const runMaintenance = () => {
  maintenance = reconcile(state).finally(() => {
    if (!state.draining) maintenanceTimer = setTimeout(runMaintenance, 60_000);
  });
};
runMaintenance();
const sessionTimer = setInterval(() => {
  try {
    expireStaleSessions(state);
    pruneResults(state);
  } catch {
    console.warn("session expiry requires retry");
  }
}, 1000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (state.draining) return;
    state.draining = true;
    clearTimeout(maintenanceTimer);
    clearInterval(sessionTimer);
    for (const requests of state.cancellations.values())
      for (const controller of requests.values()) controller.abort();
    // Relays settle confirmed delivery first; then release sessions that never
    // connected and any remaining reservations through the existing recovery path.
    const audioClosed = closeAudio().then(() => recoverRestart(state));
    const deadline = setTimeout(() => {
      console.error(
        "backend shutdown deadline exceeded; restart recovery required",
      );
      process.exit(1);
    }, 140_000);
    deadline.unref();
    server.close(async () => {
      await Promise.all([maintenance, audioClosed]);
      serviceDb.close();
      db.close();
      clearTimeout(deadline);
      process.exit(0);
    });
  });
