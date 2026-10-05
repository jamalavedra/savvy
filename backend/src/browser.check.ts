import { briefSupplier } from "./brief-supplier.check.js";
import test from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { SMTPServer } from "smtp-server";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createAuth } from "./auth.js";
import { migrate } from "./migrate.js";

test(
  process.env.SAVVY_NATIVE_CHECK === "1"
    ? "real browser OTP completes Tauri IPC, refresh rotation, cancellation and sign-out"
    : "same-origin browser OTP handoff, keyboard entry and narrow layouts",
  { timeout: process.env.SAVVY_NATIVE_CHECK === "1" ? 120_000 : 180_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "savvy-auth-browser-"));
    const screenshots = resolve("../target/check-evidence");
    await mkdir(screenshots, { recursive: true });
    let message = "";
    const smtp = new SMTPServer({
      disabledCommands: ["AUTH", "STARTTLS"],
      onData(stream, _session, done) {
        message = "";
        stream.on("data", (chunk) => {
          message += chunk.toString();
        });
        stream.on("end", done);
      },
    });
    await new Promise<void>((done) => smtp.listen(0, "127.0.0.1", done));
    const listener = createServer();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((done) => listener.close(() => done()));
    const supplier =
      process.env.SAVVY_NATIVE_BRIEF_CHECK === "1"
        ? await briefSupplier(directory)
        : null;
    const env = {
      PATH: process.env.PATH,
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
      SAVVY_ANTHROPIC_BASE_URL: supplier?.url ?? `http://127.0.0.1:${port}`,
      SAVVY_DEV_FIXTURES: supplier ? "1" : "0",
      SAVVY_DEEPGRAM_URL: `ws://127.0.0.1:${port}`,
      SAVVY_STRIPE_BASE_URL: `http://127.0.0.1:${port}`,
      SAVVY_CHECKOUT_RETURN_URL: `http://127.0.0.1:${port}/complete`,
      PORT: String(port),
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String((smtp.server.address() as { port: number }).port),
      SMTP_FROM: "auth@example.test",
      // Render the configured-provider control; this test never calls Google.
      GOOGLE_CLIENT_ID: "synthetic-browser-layout",
      GOOGLE_CLIENT_SECRET: "synthetic-browser-layout",
    };
    const instance = createAuth(env);
    await migrate(instance);
    instance.db.close();
    const server = spawn(
      process.execPath,
      ["--import", "tsx", "src/server.ts"],
      { env, stdio: "ignore" },
    );
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({
        headless: true,
        ...(process.env.SAVVY_CHROMIUM
          ? { executablePath: process.env.SAVVY_CHROMIUM }
          : {}),
      });
      for (let i = 0; i < 100; i++) {
        if (
          await fetch(env.BETTER_AUTH_URL + "/configuration")
            .then((r) => r.ok)
            .catch(() => false)
        )
          break;
        await new Promise((done) => setTimeout(done, 100));
      }
      if (process.env.SAVVY_NATIVE_CHECK === "1") {
        await writeFile(
          join(directory, "state.json"),
          JSON.stringify({
            authentication: "better-auth-pkce",
            service: env.BETTER_AUTH_URL,
            issuer: env.BETTER_AUTH_URL,
            clientId: "savvy-desktop",
            audience: "https://api.savvycopilot.com",
          }),
          { mode: 0o600 },
        );
        const native = spawn(
          "cargo",
          [
            "test",
            "-p",
            "savvy",
            "--lib",
            "local_stripe_sandbox_desktop_transport",
            "--locked",
            "--",
            "--ignored",
          ],
          {
            cwd: resolve(".."),
            env: {
              ...process.env,
              SAVVY_E2E_DIR: directory,
              SAVVY_E2E_PRODUCT: "account",
              SAVVY_E2E_WAIT_LOGOUT: "1",
              SAVVY_NATIVE_BRIEF_CHECK: supplier ? "1" : "0",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        native.stdout.on("data", (chunk) => {
          output = (output + chunk).slice(-16000);
        });
        native.stderr.on("data", (chunk) => {
          output = (output + chunk).slice(-16000);
        });
        const exited = new Promise<number | null>((resolve, reject) => {
          native.once("error", reject);
          native.once("exit", resolve);
        });
        try {
          let authorization: { authorizationUrl: string } | undefined;
          for (let attempt = 0; attempt < 800; attempt++) {
            assert.equal(native.exitCode, null, output);
            authorization = await readFile(
              join(directory, "authorization.json"),
              "utf8",
            )
              .then(JSON.parse)
              .catch(() => undefined);
            if (authorization) break;
            await new Promise((done) => setTimeout(done, 100));
          }
          assert.ok(authorization, "native authorization did not arrive");
          const page = await browser.newPage();
          await page.goto(authorization.authorizationUrl);
          await page
            .getByLabel("Email", { exact: true })
            .fill("native-browser@example.test");
          await page.getByRole("button", { name: "Email me a code" }).click();
          const code = page.getByLabel("Email code", { exact: true });
          await code.waitFor();
          const otp = message.match(/code is (\d{6})/)?.[1];
          assert.ok(otp);
          await code.fill(otp);
          await code.press("Enter");
          const open = page.getByRole("link", { name: "Open Savvy" });
          await open.waitFor();
          const callback = await open.getAttribute("href");
          assert.ok(callback);
          const signedIn = await page.request.get(
            env.BETTER_AUTH_URL + "/api/auth/get-session",
          );
          assert.equal(signedIn.status(), 200);
          assert.equal(
            (await signedIn.json()).user.email,
            "native-browser@example.test",
          );
          await writeFile(join(directory, "callback.tmp"), callback, {
            mode: 0o600,
          });
          await rename(
            join(directory, "callback.tmp"),
            join(directory, "callback.txt"),
          );
          for (let attempt = 0; attempt < 200; attempt++) {
            if (
              await readFile(join(directory, "signed-out"))
                .then(() => true)
                .catch(() => false)
            )
              break;
            assert.equal(native.exitCode, null, output);
            await new Promise((done) => setTimeout(done, 25));
          }
          let revoked = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            const response = await page.request.get(
              env.BETTER_AUTH_URL + "/api/auth/get-session",
            );
            revoked =
              response.status() === 200 && (await response.json()) === null;
            if (revoked) break;
            await new Promise((done) => setTimeout(done, 25));
          }
          assert.ok(
            revoked,
            "native sign-out must revoke the associated browser session",
          );
          await writeFile(join(directory, "logout-confirmed"), "confirmed", {
            mode: 0o600,
          });
          assert.equal(await exited, 0, output);
          const result = JSON.parse(
            await readFile(join(directory, "desktop-result.json"), "utf8"),
          );
          assert.equal(result.account.identity.issuer, env.BETTER_AUTH_URL);
          assert.equal(result.account.identity.emailVerified, true);
          assert.equal(result.account.meetingMsAvailable, 0);
          assert.equal(result.url, null);
          if (supplier) {
            assert.equal(result.briefCancellation, "passed");
            assert.equal(result.contextAdmission, "passed");
          }
          await page.close();
        } finally {
          if (native.exitCode === null && native.signalCode === null)
            native.kill("SIGKILL");
          await exited;
        }
        return;
      }
      const unsolicited = await browser.newPage();
      const forged =
        "com.alamaslabs.savvy:/oauth/callback?code=synthetic-unissued&state=unsolicited";
      await unsolicited.goto(
        `${env.BETTER_AUTH_URL}/complete#${encodeURIComponent(forged)}`,
      );
      await unsolicited.getByRole("heading", { level: 1 }).waitFor();
      assert.notEqual(
        await unsolicited.getByRole("heading", { level: 1 }).textContent(),
        "You are signed in",
      );
      await unsolicited.getByRole("alert").waitFor();
      assert.equal(
        await unsolicited
          .getByRole("link", { name: "Open Savvy", exact: true })
          .count(),
        0,
      );
      assert.equal(await unsolicited.evaluate(() => location.hash), "");
      await unsolicited.close();
      for (const colorScheme of ["light", "dark"] as const) {
        // Both journeys share loopback's durable three-email/minute limit.
        // Preserve the production limit and let it reset between journeys.
        if (colorScheme === "dark")
          await new Promise((done) => setTimeout(done, 60_000));
        const page = await browser.newPage({
          viewport: { width: 375, height: 812 },
          colorScheme,
        });
        await page.clock.install();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        const verifier = randomBytes(32).toString("base64url");
        const url = new URL(env.BETTER_AUTH_URL + "/api/auth/oauth2/authorize");
        for (const [key, value] of Object.entries({
          client_id: "savvy-desktop",
          response_type: "code",
          redirect_uri: "com.alamaslabs.savvy:/oauth/callback",
          scope: "openid email profile offline_access",
          resource: "https://api.savvycopilot.com",
          state: "browser-state",
          code_challenge_method: "S256",
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
        }))
          url.searchParams.set(key, value);
        if (colorScheme === "light") url.searchParams.set("prompt", "create");
        await page.goto(url.href);
        await page
          .getByRole("button", { name: "Sign in with Google", exact: true })
          .waitFor();
        await page
          .getByLabel("Email", { exact: true })
          .fill(`browser-${colorScheme}@example.test`);
        await page.screenshot({
          path: join(screenshots, `auth-email-${colorScheme}-375.png`),
          fullPage: true,
        });
        await page
          .getByRole("button", { name: "Sign in with Google", exact: true })
          .waitFor();
        assert.equal(
          await page
            .locator(".google-button img")
            .evaluate((image) => (image as HTMLImageElement).naturalWidth > 0),
          true,
        );
        for (const mode of ["Sign in", "Create account"]) {
          if (
            (await page.getByRole("heading", { level: 1 }).textContent()) !==
            mode
          )
            await page
              .getByRole("button", {
                name: /Already have an account|New to Savvy/,
              })
              .click();
          await page.screenshot({
            path: join(
              screenshots,
              `auth-${mode === "Sign in" ? "sign-in" : "create"}-${colorScheme}-375.png`,
            ),
            fullPage: true,
          });
        }
        await page.setViewportSize({ width: 680, height: 570 });
        await page.screenshot({
          path: join(screenshots, `auth-email-${colorScheme}-680.png`),
          fullPage: true,
        });
        await page.setViewportSize({ width: 375, height: 812 });
        await page.getByRole("button", { name: "Email me a code" }).click();
        const field = page.getByLabel("Email code", { exact: true });
        await field.waitFor();
        await field.fill("001234");
        assert.equal(await field.inputValue(), "001234");
        await page.screenshot({
          path: join(screenshots, `auth-code-${colorScheme}-375.png`),
          fullPage: true,
        });
        // Wait for the real server cooldown, then observe another delivered code.
        await page
          .getByRole("button", { name: "Resend code", exact: true })
          .click({ timeout: 35_000 });
        await page
          .getByRole("status")
          .filter({ hasText: "New code sent" })
          .waitFor();
        assert.equal(await field.inputValue(), "");
        await page.screenshot({
          path: join(screenshots, `auth-resent-${colorScheme}-375.png`),
          fullPage: true,
        });
        // Advance only the browser clock to inspect expiry. Server expiry is
        // covered separately; no synthetic expiry is presented as a valid login.
        await page.clock.fastForward(600_001);
        await page
          .getByRole("status")
          .filter({ hasText: "This code has expired" })
          .waitFor();
        assert.equal(await field.isDisabled(), true);
        await page.screenshot({
          path: join(screenshots, `auth-expired-${colorScheme}-375.png`),
          fullPage: true,
        });
        await page
          .getByRole("button", { name: "Back to sign in", exact: true })
          .click();
        assert.equal(
          await page.getByRole("heading", { level: 1 }).textContent(),
          "Sign in",
        );
        await page
          .getByLabel("Email", { exact: true })
          .fill(
            `long-email-address-for-narrow-layout-${colorScheme}@example.test`,
          );
        await page
          .getByRole("button", { name: "Email me a code", exact: true })
          .click();
        await field.waitFor();
        const otp = message.match(/code is (\d{6})/)?.[1];
        assert.ok(otp);
        await field.fill(otp === "000000" ? "111111" : "000000");
        await field.press("Enter");
        await page.getByRole("alert").waitFor();
        assert.equal(
          await page.getByRole("alert").textContent(),
          "That code is incorrect. Try again.",
        );
        assert.equal(
          await field.evaluate((element) => element === document.activeElement),
          true,
        );
        await page.screenshot({
          path: join(screenshots, `auth-incorrect-${colorScheme}-375.png`),
          fullPage: true,
        });
        await page.route("**/api/auth/sign-in/email-otp", async (route) => {
          await new Promise((done) => setTimeout(done, 400));
          await route.continue();
        });
        await field.fill(otp);
        await field.press("Enter");
        await page.getByRole("button", { name: "Checking code…" }).waitFor();
        assert.equal(await field.isDisabled(), true);
        await page.screenshot({
          path: join(screenshots, `auth-checking-${colorScheme}-375.png`),
          fullPage: true,
        });
        const open = page.getByRole("link", { name: "Open Savvy" });
        await open.waitFor();
        const callback = new URL((await open.getAttribute("href"))!);
        assert.equal(callback.searchParams.get("state"), "browser-state");
        assert.equal(callback.searchParams.get("iss"), env.BETTER_AUTH_URL);
        assert.ok(callback.searchParams.get("code"));
        // Exercise the same full-page callback handoff used after provider redirects.
        await page.goto(
          `${env.BETTER_AUTH_URL}/complete#${encodeURIComponent(callback.href)}`,
        );
        await page
          .getByRole("link", { name: "Open Savvy", exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole("link", { name: "Open Savvy", exact: true })
            .getAttribute("href"),
          callback.href,
        );
        assert.equal(await page.evaluate(() => location.hash), "");
        const metadata = await (
          await fetch(env.BETTER_AUTH_URL + "/.well-known/openid-configuration")
        ).json();
        const exchange = await fetch(metadata.token_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: "savvy-desktop",
            code: callback.searchParams.get("code")!,
            code_verifier: verifier,
            redirect_uri: "com.alamaslabs.savvy:/oauth/callback",
          }),
        });
        assert.equal(exchange.status, 200);
        const tokens = await exchange.json();
        const account = await fetch(env.BETTER_AUTH_URL + "/v1/account", {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        });
        assert.equal(account.status, 200);
        const summary = await account.json();
        assert.equal(summary.identity.issuer, env.BETTER_AUTH_URL);
        assert.equal(summary.identity.emailVerified, true);
        assert.equal(summary.meetingMsAvailable, 0);
        assert.equal(
          (await fetch(env.BETTER_AUTH_URL + "/v1/account")).status,
          401,
        );
        // Do not persist the one-use authorization code in screenshots.
        await page.screenshot({
          path: join(screenshots, `auth-return-${colorScheme}-375.png`),
          fullPage: true,
        });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        await page.evaluate(() => {
          document.body.style.zoom = "2";
        });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        await page.screenshot({
          path: join(screenshots, `auth-return-${colorScheme}-zoom-200.png`),
          fullPage: true,
        });
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally {
      await browser?.close();
      await supplier?.close();
      server.kill("SIGTERM");
      await new Promise<void>((done) => server.once("exit", () => done()));
      await new Promise<void>((done) => smtp.close(done));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
