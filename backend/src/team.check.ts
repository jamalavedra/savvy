import test from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { SMTPServer } from "smtp-server";
import { createServer } from "node:http";
import { createServer as portListener } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { createAuth } from "./auth.js";
import { migrate } from "./migrate.js";
import { openServiceDatabase } from "./db.js";
import { setCapability } from "./capability.js";
import { CATALOG } from "./catalog.js";

test(
  "production team page: purchase, delivered invitations, OTP/Google-fixture continuation, reload, keyboard assignment and private views",
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "savvy-team-browser-")),
      evidence = resolve("../target/check-evidence/team");
    await mkdir(evidence, { recursive: true });
    const messages: { email: string; raw: string }[] = [];
    const smtp = new SMTPServer({
      disabledCommands: ["AUTH", "STARTTLS"],
      onData(stream, session, done) {
        let raw = "";
        stream.on("data", (chunk) => {
          raw += chunk.toString();
        });
        stream.on("end", () => {
          messages.push({ email: session.envelope.rcptTo[0].address, raw });
          done();
        });
      },
    });
    await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
    const free = portListener();
    free.listen(0, "127.0.0.1");
    await once(free, "listening");
    const address = free.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((r) => free.close(() => r()));
    const smtpAddress = smtp.server.address();
    assert.ok(smtpAddress && typeof smtpAddress !== "string");
    let checkout: Record<string, unknown> | null = null,
      subscription: Record<string, unknown> | null = null,
      invoice: Record<string, unknown> | null = null;
    const supplier = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://fixture");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      let value: unknown;
      if (url.pathname === "/pay") {
        assert.ok(checkout);
        checkout.status = "complete";
        checkout.payment_status = "paid";
        checkout.subscription = "sub_team";
        const item = (checkout.line_items as { data: { quantity: number }[] })
            .data[0],
          start = Math.floor(Date.now() / 1000);
        subscription = {
          id: "sub_team",
          customer: "cus_team",
          status: "active",
          latest_invoice: "in_team",
          items: {
            data: [
              {
                id: "si_team",
                price: "price_monthly",
                quantity: item.quantity,
              },
            ],
          },
          cancel_at_period_end: false,
        };
        invoice = {
          id: "in_team",
          customer: "cus_team",
          status: "paid",
          currency: "usd",
          amount_paid: item.quantity * CATALOG.monthly.amountCents,
          billing_reason: "subscription_create",
          parent: { subscription_details: { subscription: "sub_team" } },
          lines: {
            data: [
              {
                quantity: item.quantity,
                pricing: { price_details: { price: "price_monthly" } },
                period: { start, end: start + 30 * 24 * 3600 },
                parent: {
                  subscription_item_details: {
                    subscription_item: "si_team",
                    proration: false,
                  },
                },
              },
            ],
          },
        };
        const body = JSON.stringify({
            id: "evt_team_paid",
            type: "invoice.paid",
            data: { object: { id: "in_team" } },
          }),
          time = Math.floor(Date.now() / 1000),
          signature = createHmac("sha256", "synthetic")
            .update(`${time}.${body}`)
            .digest("hex");
        const response = await fetch(base + "/v1/billing/webhook", {
          method: "POST",
          headers: {
            "stripe-signature": `t=${time},v1=${signature}`,
            "x-savvy-proxy-ip": "10.0.0.9",
          },
          body,
        });
        assert.equal(response.status, 200, await response.text());
        res.writeHead(302, { location: base + "/team?checkout=returned" });
        res.end();
        return;
      }
      assert.equal(req.headers["stripe-version"], "2025-06-30.basil");
      if (url.pathname === "/v1/prices/price_monthly")
        value = {
          id: "price_monthly",
          active: true,
          currency: "usd",
          unit_amount: CATALOG.monthly.amountCents,
          billing_scheme: "per_unit",
          transform_quantity: null,
          type: "recurring",
          recurring: {
            interval: "month",
            interval_count: 1,
            usage_type: "licensed",
          },
          metadata: { savvy_catalog_version: CATALOG.monthly.version },
        };
      else if (url.pathname === "/v1/customers") value = { id: "cus_team" };
      else if (
        url.pathname === "/v1/checkout/sessions" &&
        req.method === "POST"
      ) {
        checkout = {
          id: "cs_team",
          customer: "cus_team",
          status: "open",
          payment_status: "unpaid",
          mode: "subscription",
          url: "https://checkout.stripe.com/c/fixture-team",
          metadata: {
            savvy_org: form.get("metadata[savvy_org]"),
            savvy_key: form.get("metadata[savvy_key]"),
          },
          line_items: {
            data: [
              {
                quantity: Number(form.get("line_items[0][quantity]")),
                price: form.get("line_items[0][price]"),
              },
            ],
          },
        };
        value = checkout;
      } else if (url.pathname === "/v1/checkout/sessions/cs_team")
        value = checkout;
      else if (url.pathname === "/v1/subscriptions/sub_team")
        value = subscription;
      else if (url.pathname === "/v1/invoices/in_team") value = invoice;
      else if (url.pathname === "/v1/events")
        value = { data: [], has_more: false };
      else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    });
    supplier.listen(0, "127.0.0.1");
    await once(supplier, "listening");
    const supplierAddress = supplier.address();
    assert.ok(supplierAddress && typeof supplierAddress !== "string");
    const stripe = `http://127.0.0.1:${supplierAddress.port}`;
    const env = {
      PATH: process.env.PATH,
      PORT: String(address.port),
      BETTER_AUTH_URL: base,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      SAVVY_AUTH_DATABASE: join(directory, "auth.sqlite"),
      SAVVY_DB_PATH: join(directory, "service.sqlite"),
      SAVVY_OIDC_ISSUER: base,
      SAVVY_ANTHROPIC_API_KEY: "synthetic",
      SAVVY_DEEPGRAM_API_KEY: "synthetic",
      SAVVY_STRIPE_SECRET_KEY: "synthetic",
      SAVVY_STRIPE_WEBHOOK_SECRET: "synthetic",
      SAVVY_STRIPE_PRICE_MONTHLY: "price_monthly",
      SAVVY_STRIPE_PRICE_PACK: "price_pack",
      SAVVY_STRIPE_BASE_URL: stripe,
      SAVVY_ANTHROPIC_BASE_URL: stripe,
      SAVVY_DEEPGRAM_URL: stripe.replace("http:", "ws:"),
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(smtpAddress.port),
      SMTP_FROM: "auth@example.test",
      SAVVY_AUTH_TRUSTED_PROXIES: "127.0.0.1",
      GOOGLE_CLIENT_ID: "synthetic-team-google",
      GOOGLE_CLIENT_SECRET: "synthetic-team-google",
    };
    const instance = createAuth(env);
    await migrate(instance);
    instance.mail.close();
    instance.db.close();
    const seed = openServiceDatabase(env.SAVVY_DB_PATH);
    seed
      .transaction(() =>
        setCapability(seed, "team_purchase_enabled", "1", BigInt(Date.now())),
      )
      .immediate();
    seed.close();
    const child = spawn(process.execPath, ["build/server.js"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (data) => {
      logs += data;
    });
    child.stderr.on("data", (data) => {
      logs += data;
    });
    let browser: Browser | undefined;
    const requests: string[] = [],
      tokens: string[] = [],
      browserErrors: string[] = [];
    try {
      for (let n = 0; n < 100; n++) {
        if (
          await fetch(base + "/readyz", {
            headers: { "x-savvy-proxy-ip": "10.0.0.9" },
          })
            .then((r) => r.ok)
            .catch(() => false)
        )
          break;
        await new Promise((r) => setTimeout(r, 100));
      }
      browser = await chromium.launch({
        headless: true,
        ...(process.env.SAVVY_CHROMIUM
          ? { executablePath: process.env.SAVVY_CHROMIUM }
          : {}),
      });
      let identity = 0;
      const context = async () => {
        const value = await browser!.newContext({
          viewport: { width: 1024, height: 850 },
          extraHTTPHeaders: { "x-savvy-proxy-ip": `10.0.0.${++identity}` },
        });
        value.on("page", (page) => {
          page.on("request", (r) => requests.push(r.url()));
          page.on("pageerror", (error) => browserErrors.push(error.message));
        });
        return value;
      };
      async function login(page: Page, email: string) {
        await page.getByLabel("Email", { exact: true }).fill(email);
        await page
          .getByRole("button", { name: "Email me a code", exact: true })
          .click();
        await page.getByLabel("Email code", { exact: true }).waitFor();
        const otp = messages
          .slice()
          .reverse()
          .find((m) => m.email === email)
          ?.raw.match(/code is (\d{6})/)?.[1];
        assert.ok(otp);
        await page.getByLabel("Email code", { exact: true }).fill(otp);
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
      }
      const ownerContext = await context(),
        owner = await ownerContext.newPage();
      await owner.goto(base + "/team");
      await owner.getByRole("link", { name: "Sign in", exact: true }).click();
      await login(owner, "owner@example.test");
      await owner.getByLabel("Organization name").fill("Example team");
      await owner
        .getByRole("button", { name: "Create organization", exact: true })
        .click();
      await owner
        .getByRole("heading", { name: "Team billing", exact: true })
        .waitFor();
      await owner.route("https://checkout.stripe.com/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<html><body><h1>Synthetic Stripe Checkout</h1><a href="${stripe}/pay">Pay fixture invoice</a></body></html>`,
        }),
      );
      await owner.getByLabel("Seats to buy").fill("2");
      await owner
        .getByRole("button", { name: "Continue to checkout", exact: true })
        .click();
      await owner.getByRole("link", { name: "Pay fixture invoice" }).click();
      await owner.getByText(/2 seats paid through/).waitFor();
      async function invite(email: string) {
        await owner.getByLabel("Member email", { exact: true }).focus();
        await owner.keyboard.type(email);
        await owner.keyboard.press("Tab");
        await owner.keyboard.press("Tab");
        await owner.keyboard.press("Enter");
        await owner
          .getByText("Invitation sent. It expires in 7 days.", { exact: true })
          .waitFor();
        const message = messages
          .slice()
          .reverse()
          .find(
            (m) =>
              m.email === email && m.raw.includes("Join your team on Savvy"),
          );
        assert.ok(message);
        const decoded = message.raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
        const link = decoded.match(
          /https?:\/\/[^\s]+\/team\/join#[A-Za-z0-9_-]{43}/,
        )?.[0];
        assert.ok(link);
        tokens.push(new URL(link).hash.slice(1));
        return link;
      }
      const first = await invite("member@example.test"),
        memberContext = await context(),
        member = await memberContext.newPage();
      await member.goto(first);
      await member.getByRole("link", { name: "Sign in", exact: true }).click();
      await login(member, "member@example.test");
      await member
        .getByRole("heading", { name: "You joined Example team", exact: true })
        .waitFor();
      assert.match(
        await member.locator("body").innerText(),
        /The owner will assign a seat/,
      );
      await owner.getByRole("button", { name: "Refresh", exact: true }).click();
      const picker = owner.locator(
        'button[aria-label="Assign member to seat 2"]:enabled',
      );
      await picker.waitFor();
      await picker.focus();
      await picker.press("ArrowDown");
      await owner
        .getByRole("listbox", { name: "Assign member to seat 2", exact: true })
        .waitFor();
      await owner.keyboard.press("End");
      await owner.keyboard.press("Enter");
      await owner
        .locator('button[aria-label="Assign seat 2"]:enabled')
        .waitFor();
      await owner.keyboard.press("Tab");
      await owner.keyboard.press("Enter");
      await owner.getByText("Seat 2 assigned.", { exact: true }).waitFor();
      await member
        .getByRole("button", { name: "Refresh", exact: true })
        .click();
      await member
        .getByRole("heading", { name: "Your seat", exact: true })
        .waitFor();
      for (const width of [375, 1024])
        for (const colorScheme of ["light", "dark"] as const) {
          await owner.setViewportSize({ width, height: 850 });
          await owner.emulateMedia({ colorScheme });
          assert.equal(
            await owner.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
          );
          await owner.screenshot({
            path: join(evidence, `owner-${width}-${colorScheme}.png`),
            fullPage: true,
          });
        }
      await owner.setViewportSize({ width: 1024, height: 850 });
      const reloadLink = await invite("reload@example.test"),
        reloadContext = await context(),
        reload = await reloadContext.newPage();
      await reload.goto(reloadLink);
      await reload
        .getByRole("link", { name: "Sign in", exact: true })
        .waitFor();
      assert.equal(new URL(reload.url()).hash, "");
      await reload.reload();
      await reload.getByRole("link", { name: "Sign in", exact: true }).click();
      await login(reload, "reload@example.test");
      await reload
        .getByRole("heading", { name: "You joined Example team", exact: true })
        .waitFor();
      const googleLink = await invite("google@example.test"),
        googleContext = await context(),
        google = await googleContext.newPage();
      await google.goto(googleLink);
      await google.getByRole("link", { name: "Sign in", exact: true }).click();
      await google.route("**/api/auth/sign-in/social", async (route) => {
        assert.equal(route.request().postDataJSON().callbackURL, "/team/join");
        await route.fulfill({
          json: {
            url: "https://fixture-google.test/authorize",
            redirect: true,
          },
        });
      });
      await google.route("https://fixture-google.test/**", async (route) => {
        const sent = await googleContext.request.post(
          base + "/api/auth/email-otp/send-verification-otp",
          {
            headers: { origin: base },
            data: { email: "google@example.test", type: "sign-in" },
          },
        );
        assert.equal(sent.status(), 200);
        const otp = messages
          .slice()
          .reverse()
          .find((m) => m.email === "google@example.test")!
          .raw.match(/code is (\d{6})/)![1];
        const verified = await googleContext.request.post(
          base + "/api/auth/sign-in/email-otp",
          {
            headers: { origin: base },
            data: { email: "google@example.test", otp },
          },
        );
        assert.equal(verified.status(), 200);
        await route.fulfill({
          status: 302,
          headers: { location: base + "/team/join" },
          body: "",
        });
      });
      await google
        .getByRole("button", { name: "Sign in with Google", exact: true })
        .click();
      await google
        .getByRole("heading", { name: "You joined Example team", exact: true })
        .waitFor();
      const wrongLink = await invite("invited@example.test"),
        wrongContext = await context(),
        wrong = await wrongContext.newPage();
      await wrong.goto(wrongLink);
      await wrong.getByRole("link", { name: "Sign in", exact: true }).click();
      await login(wrong, "different@example.test");
      await wrong
        .getByRole("alert")
        .filter({ hasText: "invited email address" })
        .waitFor();
      assert.equal(
        await wrong.evaluate(() => sessionStorage.getItem("savvy.invite")),
        null,
      );
      await member.goto(first);
      await member
        .getByRole("alert")
        .filter({ hasText: /invalid, expired, used or revoked/ })
        .waitFor();
      for (const token of tokens) {
        assert.equal(
          requests.some((url) => url.includes(token)),
          false,
        );
        assert.equal(logs.includes(token), false);
      }
      assert.deepEqual(browserErrors, []);
      assert.equal(logs.includes("owner@example.test"), false);
      await owner.screenshot({
        path: join(evidence, "owner-final.png"),
        fullPage: true,
      });
    } catch (error) {
      if (browser)
        for (const [index, context] of browser.contexts().entries())
          await context
            .pages()[0]
            ?.screenshot({
              path: join(evidence, `failure-${index}.png`),
              fullPage: true,
            })
            .catch(() => {});
      throw error;
    } finally {
      await browser?.close();
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
      supplier.closeAllConnections();
      await new Promise<void>((r) => supplier.close(() => r()));
      await new Promise<void>((r) => smtp.close(() => r()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
