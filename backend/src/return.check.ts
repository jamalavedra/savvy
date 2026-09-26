import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join, sep, extname } from "node:path";
import { chromium } from "playwright";

test(
  "static payment return stays pending, accessible and narrow in both themes",
  { timeout: 30_000 },
  async () => {
    const root = resolve("../www/out");
    const evidence = resolve("../target/check-evidence");
    await mkdir(evidence, { recursive: true });
    const server = createServer(async (request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const file = resolve(
        root,
        `.${path}`,
        path.endsWith("/") ? "index.html" : "",
      );
      if (!file.startsWith(root + sep)) {
        response.writeHead(404).end();
        return;
      }
      try {
        const body = await readFile(file);
        const types: Record<string, string> = {
          ".html": "text/html",
          ".css": "text/css",
          ".js": "text/javascript",
          ".png": "image/png",
          ".woff2": "font/woff2",
        };
        response.setHeader(
          "Content-Type",
          types[extname(file)] ?? "application/octet-stream",
        );
        response.end(body);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({
        headless: true,
        ...(process.env.SAVVY_CHROMIUM
          ? { executablePath: process.env.SAVVY_CHROMIUM }
          : {}),
      });
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await browser.newPage({
          viewport: { width: 375, height: 812 },
          colorScheme,
        });
        const errors: string[] = [];
        const external: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (!request.url().startsWith(origin + "/"))
            external.push(request.url());
        });
        await page.addInitScript(() => {
          localStorage.setItem(
            "savvy.analytics-consent",
            JSON.stringify({ allowed: true, expires: Date.now() + 86_400_000 }),
          );
        });
        await page.goto(
          `${origin}/checkout-complete/?payment_status=paid&success=true`,
        );
        await page.getByRole("heading", { name: "Return to Savvy" }).waitFor();
        assert.equal(
          await page
            .getByRole("complementary", { name: "Privacy preferences" })
            .count(),
          0,
        );
        assert.equal(
          await page
            .locator('script[src*="analytics.jamalavedra.com"]')
            .count(),
          0,
        );
        const text = await page.locator("main").innerText();
        assert.match(text, /It may still be pending/);
        assert.match(text, /This page does not confirm payment/);
        assert.match(text, /explicitly resume/);
        assert.doesNotMatch(text, /payment successful|purchase complete/i);
        const open = page.getByRole("link", {
          name: "Open Savvy",
          exact: true,
        });
        assert.equal(
          await open.getAttribute("href"),
          "com.alamaslabs.savvy:/billing/return",
        );
        await page.keyboard.press("Tab");
        assert.equal(
          await open.evaluate((element) => element === document.activeElement),
          true,
        );
        for (const width of [375, 680]) {
          await page.setViewportSize({
            width,
            height: width === 375 ? 812 : 570,
          });
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
            false,
          );
          await page.screenshot({
            path: join(evidence, `payment-return-${colorScheme}-${width}.png`),
            fullPage: true,
          });
        }
        await page.setViewportSize({ width: 375, height: 812 });
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
          path: join(evidence, `payment-return-${colorScheme}-zoom-200.png`),
          fullPage: true,
        });
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        await page.close();
      }
    } finally {
      await browser?.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);
