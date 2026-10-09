import test from "node:test";
import assert from "node:assert/strict";
import { request, createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { mkdtemp, rm, link, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { createAuth } from "./auth.js";
import { migrate } from "./migrate.js";
import { readBody } from "./api.js";

for (const proxyHeader of ["x-savvy-proxy-ip", "cf-connecting-ip"])
  test(
    `HTTP boundary limits streaming bodies and trusts only configured proxy peers using ${proxyHeader}`,
    { timeout: 30000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "savvy-auth-http-"));
      const listener = createServer();
      await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
      const port = (listener.address() as { port: number }).port;
      await new Promise<void>((r) => listener.close(() => r()));
      const env = {
        ...process.env,
        PORT: String(port),
        BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        SAVVY_AUTH_DATABASE: join(directory, "auth.sqlite"),
        SAVVY_DB_PATH: join(directory, "service.sqlite"),
        SAVVY_OIDC_ISSUER: `http://127.0.0.1:${port}`,
        SAVVY_ANTHROPIC_API_KEY: "synthetic",
        SAVVY_DEEPGRAM_API_KEY: "synthetic",
        SAVVY_STRIPE_SECRET_KEY: "synthetic",
        SAVVY_STRIPE_WEBHOOK_SECRET: "synthetic",
        SAVVY_STRIPE_PRICE_MONTHLY: "price_monthly",
        SAVVY_STRIPE_PRICE_PACK: "price_pack",
        SAVVY_ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        SAVVY_DEEPGRAM_URL: `ws://127.0.0.1:${port}`,
        SAVVY_STRIPE_BASE_URL: `http://127.0.0.1:${port}`,
        SAVVY_CHECKOUT_RETURN_URL: `http://127.0.0.1:${port}/complete`,
        SAVVY_AUTH_TRUSTED_PROXIES: "127.0.0.1",
        SAVVY_AUTH_PROXY_IP_HEADER:
          proxyHeader === "cf-connecting-ip" ? proxyHeader : undefined,
      };
      const instance = createAuth(env);
      await migrate(instance);
      let child = spawn(
        process.execPath,
        ["--import", "tsx", "src/server.ts"],
        {
          env,
          stdio: "ignore",
        },
      );
      const send = (
        path: string,
        headers: Record<string, string | string[] | undefined> = {},
        body?: string,
        localAddress = "127.0.0.1",
      ) =>
        new Promise<number>((resolve, reject) => {
          const req = request(
            `${env.BETTER_AUTH_URL}${path}`,
            {
              method: body === undefined ? "GET" : "POST",
              headers: Object.fromEntries(
                Object.entries({
                  [proxyHeader]: "192.0.2.1",
                  ...headers,
                }).filter(([, value]) => value !== undefined),
              ),
              localAddress,
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode!));
            },
          );
          req.on("error", reject);
          req.end(body);
        });
      try {
        for (let i = 0; i < 100; i++) {
          if (
            await send("/ready")
              .then((s) => s === 200)
              .catch(() => false)
          )
            break;
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(await send("/api/auth/ok"), 200);
        assert.equal(await send("/readyz"), 204);
        assert.equal(await send("/v1/account"), 401);
        assert.equal(
          await send(
            "/v1/dev/grant",
            { "content-type": "application/json" },
            '{"kind":"monthly"}',
          ),
          404,
        );
        for (const headers of [
          { "content-type": "application/json", "content-length": "1048577" },
          {
            "content-type": "application/json",
            "transfer-encoding": "chunked",
          },
        ] as Record<string, string>[])
          assert.equal(
            await send("/v1/briefs", headers, "x".repeat(1048577)),
            401,
          );
        assert.equal(
          await send(
            "/api/auth/sign-in/email-otp",
            { "content-type": "application/json", "content-length": "65537" },
            "{}",
          ),
          413,
        );
        assert.equal(
          await send(
            "/api/auth/sign-in/email-otp",
            {
              "content-type": "application/json",
              "transfer-encoding": "chunked",
            },
            "x".repeat(65537),
          ),
          413,
        );
        assert.equal(
          await send(
            "/api/auth/sign-in/email-otp",
            { "content-type": "application/json" },
            "{}",
          ),
          400,
        );
        assert.equal(
          await send("/ready", { [proxyHeader]: "2001:db8::1" }),
          200,
        );
        for (const invalid of [
          undefined,
          "invalid",
          "192.0.2.1, 192.0.2.2",
          ["192.0.2.1", "192.0.2.1"],
        ])
          assert.equal(await send("/ready", { [proxyHeader]: invalid }), 400);
        if (proxyHeader === "cf-connecting-ip")
          assert.equal(
            await send("/ready", {
              "cf-connecting-ip": undefined,
              "x-savvy-proxy-ip": "198.51.100.1",
            }),
            400,
          );
        for (let i = 0; i < 60; i++) await send("/api/auth/ok");
        assert.equal(await send("/api/auth/ok"), 429);
        assert.equal(
          await send("/api/auth/ok", { [proxyHeader]: "192.0.2.2" }),
          200,
        );
        if (proxyHeader === "cf-connecting-ip")
          assert.equal(
            await send("/api/auth/ok", {
              "cf-connecting-ip": "192.0.2.1",
              "x-savvy-proxy-ip": "198.51.100.1",
              "x-savvy-client-ip": "198.51.100.1",
            }),
            429,
          );
        child.kill("SIGTERM");
        await new Promise((r) => child.once("exit", r));
        const schema = () => {
          const copy = new Database(env.SAVVY_DB_PATH, { readonly: true });
          try {
            return copy
              .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
              .all();
          } finally {
            copy.close();
          }
        };
        const beforeMisconfiguration = schema();
        const hardlink = join(directory, "hardlink.sqlite");
        const symlinkPath = join(directory, "symlink.sqlite");
        await link(env.SAVVY_DB_PATH, hardlink);
        await symlink(env.SAVVY_DB_PATH, symlinkPath);
        for (const authPath of [env.SAVVY_DB_PATH, hardlink, symlinkPath]) {
          child = spawn(
            process.execPath,
            ["--import", "tsx", "src/server.ts"],
            {
              env: { ...env, SAVVY_AUTH_DATABASE: authPath },
              stdio: "ignore",
            },
          );
          const rejected = await new Promise((resolve) =>
            child.once("exit", resolve),
          );
          assert.notEqual(rejected, 0);
          assert.deepEqual(
            schema(),
            beforeMisconfiguration,
            "shared database paths must be rejected before auth can create tables",
          );
        }
        await rm(hardlink);
        await rm(symlinkPath);
        child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
          env: { ...env, SAVVY_AUTH_PROXY_IP_HEADER: "x-forwarded-for" },
          stdio: "ignore",
        });
        assert.notEqual(
          await new Promise((resolve) => child.once("exit", resolve)),
          0,
        );
        child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
          env: { ...env, SAVVY_AUTH_TRUSTED_PROXIES: "" },
          stdio: "ignore",
        });
        for (let i = 0; i < 100; i++) {
          if (
            await send("/ready")
              .then((s) => s === 200)
              .catch(() => false)
          )
            break;
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(
          await send("/api/auth/ok", {
            [proxyHeader]: "192.0.2.1",
            "x-savvy-client-ip": "192.0.2.1",
          }),
          200,
        );
        for (let i = 0; i < 60; i++)
          await send("/api/auth/ok", {
            [proxyHeader]: `192.0.2.${i + 2}`,
            "x-savvy-client-ip": `192.0.2.${i + 2}`,
          });
        assert.equal(
          await send("/api/auth/ok", { [proxyHeader]: "198.51.100.1" }),
          429,
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await new Promise((r) => child.once("exit", r));
        }
        instance.db.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

test("API bodies over 1 MiB are refused by declared or streamed length", async () => {
  const body = (headers: Record<string, string>, size: number) =>
    Object.assign(Readable.from([Buffer.alloc(size)]), {
      headers,
    }) as unknown as IncomingMessage;
  await assert.rejects(readBody(body({ "content-length": "1048577" }, 0)), {
    code: "context_too_large",
  });
  await assert.rejects(readBody(body({}, 1_048_577)), {
    code: "context_too_large",
  });
  assert.equal((await readBody(body({}, 1_048_576))).length, 1_048_576);
});
