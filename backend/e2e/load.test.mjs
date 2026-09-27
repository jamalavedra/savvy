import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createPrivateKey, sign, randomUUID, randomBytes } from "node:crypto";
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(root, "backend/package.json"));
const { WebSocket, WebSocketServer } = require("ws");
const { SMTPServer } = require("smtp-server");
const Database = require("better-sqlite3");
const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const p95 = (samples) =>
  [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];

test(
  "five-minute mixed audio, OTP and delayed billing load on one backend",
  { timeout: 360000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "savvy-load-"));
    const sockets = [];
    let child,
      smtpCount = 0,
      supplierFrames = 0,
      stripeCalls = 0,
      maximumQueue = 0;
    const smtp = new SMTPServer({
      disabledCommands: ["AUTH", "STARTTLS"],
      onData(stream, _session, done) {
        stream.resume();
        stream.on("end", () => {
          smtpCount++;
          done();
        });
      },
    });
    const upstream = createServer(async (req, res) => {
      stripeCalls++;
      await sleep(200);
      res
        .writeHead(503, { "content-type": "application/json" })
        .end('{"error":{"message":"synthetic delayed outage"}}');
    });
    const supplier = new WebSocketServer({ server: upstream });
    supplier.on("connection", (ws) =>
      ws.on("message", (data, binary) => {
        if (!binary) return;
        assert.equal(data.length, 1600);
        supplierFrames++;
        if (supplierFrames % 20 === 0)
          ws.send(
            JSON.stringify({
              type: "Results",
              is_final: true,
              channel: {
                alternatives: [{ transcript: "Synthetic load transcript" }],
              },
            }),
          );
        maximumQueue = Math.max(maximumQueue, ws.bufferedAmount);
      }),
    );
    try {
      upstream.listen(0, "127.0.0.1");
      await once(upstream, "listening");
      await new Promise((resolve) => smtp.listen(0, "127.0.0.1", resolve));
      const probe = createServer();
      probe.listen(0, "127.0.0.1");
      await once(probe, "listening");
      const port = probe.address().port;
      await new Promise((resolve) => probe.close(resolve));
      const origin = `http://127.0.0.1:${port}`,
        upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
      const env = {
        PATH: process.env.PATH,
        PORT: String(port),
        SAVVY_HOST: "127.0.0.1",
        BETTER_AUTH_URL: origin,
        SAVVY_OIDC_ISSUER: origin,
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        SAVVY_AUTH_DATABASE: join(directory, "auth.sqlite"),
        SAVVY_DB_PATH: join(directory, "service.sqlite"),
        SAVVY_DEV_FIXTURES: "1",
        SAVVY_ANTHROPIC_API_KEY: "synthetic",
        SAVVY_DEEPGRAM_API_KEY: "synthetic",
        SAVVY_STRIPE_SECRET_KEY: "synthetic",
        SAVVY_STRIPE_WEBHOOK_SECRET: "synthetic",
        SAVVY_STRIPE_PRICE_MONTHLY: "price_monthly",
        SAVVY_STRIPE_PRICE_PACK: "price_pack",
        SAVVY_ANTHROPIC_BASE_URL: upstreamUrl,
        SAVVY_DEEPGRAM_URL: upstreamUrl.replace("http:", "ws:"),
        SAVVY_STRIPE_BASE_URL: upstreamUrl,
        SAVVY_CHECKOUT_RETURN_URL: origin + "/complete",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(smtp.server.address().port),
        SMTP_FROM: "load@example.test",
        SAVVY_LOAD_METRICS: join(directory, "metrics.json"),
      };
      await run(process.execPath, ["--import", "tsx", "src/fixture.seed.ts"], {
        cwd: join(root, "backend"),
        env,
        timeout: 15000,
      });
      child = spawn(
        process.execPath,
        [join(root, "backend/e2e/load-process.mjs")],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk) => {
          output = (output + chunk).slice(-8000);
        });
      let exited = once(child, "exit");
      for (let i = 0; i < 100; i++) {
        if (
          await fetch(origin + "/readyz")
            .then((r) => r.status === 204)
            .catch(() => false)
        )
          break;
        await sleep(50);
      }
      const jwks = JSON.parse(
        await readFile(
          join(root, "backend/e2e/fixtures/test-issuer-jwks.json"),
          "utf8",
        ),
      );
      const key = createPrivateKey(
        await readFile(join(root, "backend/e2e/fixtures/test-issuer-rsa.pem")),
      );
      function token(index) {
        const encode = (v) =>
          Buffer.from(JSON.stringify(v)).toString("base64url");
        const now = Math.floor(Date.now() / 1000);
        const unsigned =
          encode({ alg: "RS256", kid: jwks.keys[0].kid }) +
          "." +
          encode({
            iss: origin,
            aud: "https://api.savvycopilot.com",
            sub: `load-${index}`,
            iat: now,
            exp: now + 600,
          });
        return (
          unsigned +
          "." +
          sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")
        );
      }
      const accounts = [];
      async function request(path, token, body) {
        return fetch(origin + path, {
          method: body ? "POST" : "GET",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      }
      for (let i = 0; i < 8; i++) {
        const credential = token(i),
          id = randomUUID();
        assert.equal(
          (await request("/v1/dev/grant", credential, { kind: "pack" })).status,
          200,
        );
        assert.equal(
          (await request("/v1/sessions", credential, { sessionId: id })).status,
          200,
        );
        accounts.push({ credential, id });
        for (const source of ["microphone", "system"]) {
          const ws = new WebSocket(
            `${origin.replace("http:", "ws:")}/v1/sessions/${id}/audio/${source}?leaseVersion=1`,
            { headers: { authorization: `Bearer ${credential}` } },
          );
          sockets.push(ws);
          await once(ws, "open");
          ws.on("message", (data) => {
            const message = JSON.parse(data.toString());
            assert.notEqual(message.type, "control", JSON.stringify(message));
          });
        }
      }
      const accountLatency = [],
        authLatency = [],
        billingStatus = [];
      let sentFrames = 0,
        failure;
      const start = performance.now();
      const audio = (async () => {
        for (let frame = 0; frame < 6000; frame++) {
          await sleep(Math.max(0, start + frame * 50 - performance.now()));
          for (const ws of sockets) {
            assert.equal(ws.readyState, WebSocket.OPEN);
            ws.send(Buffer.alloc(1600));
            sentFrames++;
            maximumQueue = Math.max(maximumQueue, ws.bufferedAmount);
          }
        }
      })();
      const traffic = (async () => {
        for (let i = 0; i < 60; i++) {
          await sleep(Math.max(0, start + i * 5000 - performance.now()));
          await Promise.all(
            accounts.map(async ({ credential }) => {
              const before = performance.now();
              assert.equal(
                (await request("/v1/account", credential)).status,
                200,
              );
              accountLatency.push(performance.now() - before);
            }),
          );
          const before = performance.now();
          const response = await fetch(
            origin + "/api/auth/email-otp/send-verification-otp",
            {
              method: "POST",
              headers: { "content-type": "application/json", origin },
              body: JSON.stringify({
                email: `load-${i}@example.test`,
                type: "sign-in",
              }),
            },
          );
          assert.ok(
            [200, 429].includes(response.status),
            String(response.status),
          );
          authLatency.push(performance.now() - before);
          if (i % 6 === 0) {
            const response = await request(
              "/v1/billing/checkout",
              accounts[i % 8].credential,
              { product: "pack", idempotencyKey: `load-${i}` },
            );
            billingStatus.push(response.status);
          }
        }
      })();
      await Promise.all([audio, traffic]).catch((error) => {
        failure = error;
      });
      if (failure) throw failure;
      await sleep(Math.max(0, start + 300000 - performance.now()));
      // Keep a real delayed upstream request and all audio sockets open during drain.
      const beforeDrainCalls = stripeCalls;
      const drainingCheckout = request("/v1/billing/checkout", token(99), {
        product: "pack",
        idempotencyKey: "load-shutdown-checkout",
      });
      for (
        let attempt = 0;
        stripeCalls === beforeDrainCalls && attempt < 100;
        attempt++
      )
        await sleep(5);
      assert.ok(
        stripeCalls > beforeDrainCalls,
        "checkout must reach upstream before shutdown",
      );
      child.kill("SIGINT");
      assert.deepEqual(await exited, [0, null], output);
      assert.equal((await drainingCheckout).status, 503);
      const metrics = JSON.parse(
        await readFile(env.SAVVY_LOAD_METRICS, "utf8"),
      );
      assert.equal(
        supplierFrames,
        sentFrames,
        "all sent frames reach the supplier",
      );
      assert.equal(
        metrics.sessions.reduce((n, s) => n + s.frames, 0),
        sentFrames,
      );
      const db = new Database(env.SAVVY_DB_PATH, { readonly: true });
      let rows;
      try {
        rows = db
          .prepare(
            "SELECT id,state,settled_ms,reserved_ms FROM managed_sessions ORDER BY id",
          )
          .all();
        for (const row of rows) {
          assert.equal(
            row.settled_ms,
            metrics.sessions.find((s) => s.id === row.id).unionMs,
          );
          assert.equal(row.reserved_ms, 0);
          assert.equal(row.state, "stopped");
        }
        assert.equal(
          db
            .prepare(
              "SELECT sum(amount_ms) AS n FROM usage_events WHERE kind='debit_meeting'",
            )
            .get().n,
          rows.reduce((n, r) => n + r.settled_ms, 0),
        );
      } finally {
        db.close();
      }
      const result = {
        runtime: process.version,
        hardware: {
          cpu: cpus()[0].model,
          cores: cpus().length,
          memoryBytes: totalmem(),
        },
        durationMs: performance.now() - start,
        accounts: 8,
        channels: 16,
        frameMs: 50,
        sentFrames,
        supplierFrames,
        smtpCount,
        stripeCalls,
        billingStatus,
        accountP95Ms: p95(accountLatency),
        authP95Ms: p95(authLatency),
        maximumQueueBytes: maximumQueue,
        ...metrics,
        rows,
      };
      await writeFile(
        process.env.SAVVY_LOAD_RESULTS ??
          join(root, "backend/e2e/load-results.json"),
        JSON.stringify(result, null, 2) + "\n",
      );
      child = spawn(process.execPath, [join(root, "backend/build/server.js")], {
        env,
        stdio: "ignore",
      });
      exited = once(child, "exit");
      for (let i = 0; i < 100; i++) {
        if (
          await fetch(origin + "/readyz")
            .then((r) => r.status === 204)
            .catch(() => false)
        )
          break;
        await sleep(50);
      }
      assert.equal(
        (await request("/v1/account", accounts[0].credential)).status,
        200,
      );
      child.kill("SIGINT");
      assert.deepEqual(await exited, [0, null]);
      const restarted = new Database(env.SAVVY_DB_PATH, { readonly: true });
      try {
        assert.deepEqual(
          restarted
            .prepare(
              "SELECT id,state,settled_ms,reserved_ms FROM managed_sessions ORDER BY id",
            )
            .all(),
          rows,
        );
      } finally {
        restarted.close();
      }
      result.restartPreservedStoppedSessions = true;
      result.shutdownDuringDelayedCheckout = true;
      await writeFile(
        process.env.SAVVY_LOAD_RESULTS ??
          join(root, "backend/e2e/load-results.json"),
        JSON.stringify(result, null, 2) + "\n",
      );
      assert.ok(result.accountP95Ms < 1000);
      assert.ok(result.authP95Ms < 1000);
      assert.ok(metrics.eventLoopP99Ms < 100);
      assert.ok(maximumQueue <= 32000);
      assert.ok(smtpCount > 0);
      assert.ok(stripeCalls > 0);
    } finally {
      for (const ws of sockets) ws.terminate();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      for (const ws of supplier.clients) ws.terminate();
      supplier.close();
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
      await new Promise((resolve) => smtp.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
