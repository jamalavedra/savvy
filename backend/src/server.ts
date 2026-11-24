import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { createAuth, invitationSender } from "./auth.js";
import { configuration, systemClock } from "./config.js";
import { openServiceDatabase } from "./db.js";
import { createHandler, createState, recover } from "./app.js";
import { pruneResults } from "./advice.js";
import { attachAudio } from "./transcription.js";
import { reconcile } from "./stripe.js";
import { expireStaleSessions, stopSessionsForShutdown } from "./sessions.js";

const config = configuration();
const proxyIpHeader =
  process.env.SAVVY_AUTH_PROXY_IP_HEADER ?? "x-savvy-proxy-ip";
if (!["x-savvy-proxy-ip", "cf-connecting-ip"].includes(proxyIpHeader))
  throw new Error("Invalid trusted proxy header");
const auth = createAuth();
const { db, mail } = auth;
const serviceDb = openServiceDatabase(config.serviceDatabase);
export const state = createState(
  config,
  serviceDb,
  systemClock(),
  auth,
  invitationSender(mail),
);
recover(state);
const trustedProxies = (process.env.SAVVY_AUTH_TRUSTED_PROXIES ?? "")
  .split(",")
  .filter(Boolean);
if (trustedProxies.some((ip) => !isIP(ip)))
  throw new Error("Invalid trusted proxy IP");
const server = createServer(
  createHandler(state, auth, {
    trustsPeer: (peer) => trustedProxies.includes(peer),
    proxyIpHeader,
    authBase: process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8788",
    google: Boolean(
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
    ),
    email: Boolean(mail),
    readUi: (path) =>
      readFile(new URL(`../dist${path}`, import.meta.url)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      ),
  }),
);
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
  } catch (error) {
    console.warn("session expiry requires retry", error);
  }
}, 1000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (state.draining) return;
    state.draining = true;
    clearTimeout(maintenanceTimer);
    clearInterval(sessionTimer);
    for (const requests of state.cancellations.values())
      for (const entry of requests.values()) entry.controller.abort();
    const audioClosed = closeAudio().then(() => stopSessionsForShutdown(state));
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
