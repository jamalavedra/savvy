import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { getRequest, setResponse } from "better-call/node";
import type { createAuth } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { createAuthorizer, createBrowserAuthorizer } from "./authorize.js";
import { ServiceState, type ServiceBindings } from "./state.js";
import { managedRequest } from "./api.js";
import { releaseBrief } from "./billing.js";
import { recoverRestart } from "./sessions.js";

type Auth = ReturnType<typeof createAuth>;

export interface HttpOptions {
  trustsPeer(peer: string): boolean;
  proxyIpHeader: string;
  authBase: string;
  google: boolean;
  email: boolean;
  readUi(path: string): Promise<Uint8Array | null>;
}

const PAGES = new Set([
  "/",
  "/sign-in",
  "/sign-up",
  "/consent",
  "/complete",
  "/team",
  "/team/join",
]);
const ASSET = /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/;
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function isServedPath(path: string) {
  return (
    ["/ready", "/readyz", "/configuration"].includes(path) ||
    PAGES.has(path) ||
    ASSET.test(path) ||
    ["/v1/", "/api/auth/", "/.well-known/"].some((p) => path.startsWith(p))
  );
}

export function createState(
  config: Config,
  db: Db,
  clock: () => bigint,
  auth: Auth,
  bindings: Omit<ServiceBindings, "authorizeBrowser">,
) {
  const unmetered = config.billing === null;
  return new ServiceState(
    config,
    db,
    clock,
    createAuthorizer(
      db,
      { issuer: config.issuer, audience: config.audience, unmetered },
      () => auth.auth.api.getJwks(),
      clock,
    ),
    {
      ...bindings,
      authorizeBrowser: createBrowserAuthorizer(
        db,
        { issuer: config.issuer, unmetered },
        (headers) => auth.auth.api.getSession({ headers }),
        clock,
      ),
    },
  );
}

/** Restart recovery: the session contract plus releasing unfinished briefs. */
export function recover(state: ServiceState) {
  recoverRestart(state);
  state.db
    .transaction(() => {
      const rows = state.db
        .prepare<[], { account_id: bigint; request_key: string }>(
          "SELECT account_id,request_key FROM provider_requests WHERE state='pending'",
        )
        .all();
      for (const row of rows)
        releaseBrief(state.db, row.account_id, row.request_key, state.clock());
    })
    .immediate();
}

function secureHeaders(res: ServerResponse) {
  const setHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    if (
      name.toLowerCase() === "location" &&
      typeof value === "string" &&
      value.startsWith("com.alamaslabs.savvy:/oauth/callback?")
    )
      value = "/complete#" + encodeURIComponent(value);
    return setHeader(name, value);
  };
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", CSP);
}

function clientIp(req: IncomingMessage, options: HttpOptions) {
  const peer = req.socket.remoteAddress ?? "";
  if (!options.trustsPeer(peer))
    return isIP(peer) ? { ip: peer } : { status: 400 };
  const forwarded = req.headers[options.proxyIpHeader];
  if (typeof forwarded !== "string" || !isIP(forwarded))
    return { status: 400, message: "Invalid proxy address" };
  return { ip: forwarded };
}

async function authRequest(
  auth: Auth,
  req: IncomingMessage,
  res: ServerResponse,
  base: string,
) {
  if (
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    !req.headers["content-type"]
  )
    req.headers["content-type"] = "application/octet-stream";
  const request = getRequest({ request: req, base, bodySizeLimit: 65_536 });
  // Read the bounded body here so the size-limit error reaches the 413
  // handler instead of Better Auth answering 400.
  const body = request.body ? await request.arrayBuffer() : undefined;
  await setResponse(
    res,
    await auth.auth.handler(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
      }),
    ),
  );
}

function sendJson(res: ServerResponse, value: unknown) {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(value));
}

async function route(
  state: ServiceState,
  auth: Auth,
  options: HttpOptions,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/readyz" || path.startsWith("/v1/")) {
    if (path === "/readyz")
      auth.db.prepare("SELECT id FROM jwks LIMIT 1").get();
    return managedRequest(state, req, res, path);
  }
  if (path.startsWith("/api/auth/") || path.startsWith("/.well-known/"))
    return authRequest(auth, req, res, options.authBase);
  if (path === "/ready") {
    auth.db.prepare("SELECT id FROM jwks LIMIT 1").get();
    return sendJson(res, {
      status: "ready",
      google: options.google,
      email: options.email,
      billing: state.config.billing ? "stripe" : "unmetered",
    });
  }
  if (path === "/configuration")
    return sendJson(res, { google: options.google });
  const asset = ASSET.exec(path);
  const body =
    asset || PAGES.has(path)
      ? await options.readUi(asset ? path : "/index.html")
      : null;
  if (!body) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader(
    "Content-Type",
    !asset ? "text/html" : asset[1] === "js" ? "text/javascript" : "text/css",
  );
  res.end(body);
}

export function createHandler(
  state: ServiceState,
  auth: Auth,
  options: HttpOptions,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    secureHeaders(res);
    try {
      const client = clientIp(req, options);
      if (!("ip" in client)) {
        res.writeHead(client.status).end(client.message);
        return;
      }
      req.headers["x-savvy-client-ip"] = client.ip;
      await route(state, auth, options, req, res);
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
      console.error(`${req.method} ${req.url?.split("?")[0]}`, error);
      res.writeHead(503).end("Savvy sign-in is unavailable. Try again later.");
    }
  };
}
