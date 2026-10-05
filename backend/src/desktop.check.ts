import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

test(
  "desktop demo first-launch surfaces at minimum dimensions",
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.SAVVY_CHROMIUM
        ? { executablePath: process.env.SAVVY_CHROMIUM }
        : {}),
    });
    const server = spawn(
      process.execPath,
      [
        "node_modules/vite/bin/vite.js",
        "--host",
        "127.0.0.1",
        "--port",
        "5189",
        "--strictPort",
      ],
      { cwd: "..", stdio: "ignore" },
    );
    const output = resolve("../target/check-evidence");
    await mkdir(output, { recursive: true });
    try {
      for (let i = 0; i < 100; i++) {
        if (
          await fetch("http://127.0.0.1:5189")
            .then((r) => r.ok)
            .catch(() => false)
        )
          break;
        await new Promise((done) => setTimeout(done, 100));
      }
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await browser.newPage({
          viewport: { width: 680, height: 570 },
          colorScheme,
        });
        // Use the existing synthetic demo; this is not native or provider evidence.
        await page.route("**/src/main.tsx", async (route) => {
          const response = await route.fetch();
          const body = (await response.text()).replace(
            "ReactDOM.createRoot",
            'const { resetBrowserDemoState } = await import("/src/lib/api.ts"); resetBrowserDemoState({onboardingCompleted:false}); ReactDOM.createRoot',
          );
          await route.fulfill({ response, body });
        });
        await page.route("**/src/lib/api.ts", async (route) => {
          const response = await route.fetch();
          const source = await response.text();
          const signature = "async function getMeetingHistory() {";
          assert.ok(
            source.includes(signature),
            "empty-history fixture must target the demo API",
          );
          await route.fulfill({
            response,
            body: source.replace(signature, signature + " return [];"),
          });
        });
        const capture = async (name: string) => {
          await page.screenshot({
            animations: "disabled",
            path: resolve(
              output,
              `desktop-demo-${name}-${colorScheme}-680.png`,
            ),
            fullPage: true,
          });
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
            false,
          );
        };
        await page.goto("http://127.0.0.1:5189");
        await page
          .getByRole("button", { name: "Create account", exact: true })
          .waitFor();
        await capture("welcome");
        await page.getByRole("button", { name: "View pricing" }).click();
        await page.getByRole("radio", { name: /Hours pack/ }).waitFor();
        await page.getByRole("radio", { name: /Monthly plan/ }).focus();
        await page.keyboard.press("ArrowRight");
        assert.equal(
          await page.getByRole("radio", { name: /Hours pack/ }).isChecked(),
          true,
        );
        for (const name of [
          "Continue to checkout",
          "Explore Savvy",
          "Back to provider paths",
        ]) {
          const bounds = await page
            .getByRole("button", { name, exact: true })
            .boundingBox();
          assert.ok(
            bounds && bounds.y >= 0 && bounds.y + bounds.height <= 570,
            `${name} must fit the minimum desktop viewport`,
          );
        }
        await capture("pricing");
        await page
          .getByRole("button", { name: "Back to provider paths" })
          .click();
        await page
          .getByRole("button", { name: "Create account", exact: true })
          .click();
        await page.getByRole("button", { name: "Set up later" }).waitFor();
        await capture("permissions");
        await page.getByRole("button", { name: "Set up later" }).click();
        await page
          .getByRole("heading", { name: "Prepare for your meeting" })
          .waitFor();
        await capture("prepare");
        await page
          .getByRole("button", { name: "History", exact: true })
          .click();
        const emptyHistory = page.getByText(
          "Completed meeting transcripts and insights appear here.",
          { exact: true },
        );
        await emptyHistory.waitFor();
        await capture("history-empty");
        assert.equal(
          await emptyHistory.evaluate(
            (element) =>
              element.scrollHeight <= element.clientHeight &&
              element.scrollWidth <= element.clientWidth,
          ),
          true,
          "empty-history explanation must fit its text box",
        );
        await page
          .getByRole("button", { name: "Account", exact: true })
          .click();
        await page.getByRole("heading", { name: "Savvy managed" }).waitFor();
        await capture("account");
        await page
          .getByRole("button", {
            name: "Sign out or cancel sign-in",
            exact: true,
          })
          .click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        assert.equal(
          await dialog
            .getByRole("button", { name: "Cancel" })
            .evaluate((el) => el === document.activeElement),
          true,
        );
        await capture("signout");
        await page.keyboard.press("Escape");
        assert.equal(
          await page
            .getByRole("button", {
              name: "Sign out or cancel sign-in",
              exact: true,
            })
            .evaluate((el) => el === document.activeElement),
          true,
        );
        await page.close();
      }
    } finally {
      await browser.close();
      server.kill("SIGTERM");
    }
  },
);
