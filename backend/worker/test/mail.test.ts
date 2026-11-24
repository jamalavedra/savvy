import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { createTestHarness } from "wrangler";
import { ADMIN_TOKEN, sealEmpty } from "./seal.ts";

const SENDER = "noreply@savvycopilot.com";
const ORIGIN = "http://127.0.0.1:8788";

function harness(from: string) {
  return createTestHarness({
    workers: [
      {
        configPath: new URL("./entry.wrangler.jsonc", import.meta.url),
        vars: { SAVVY_EMAIL_FROM: from },
        secrets: {
          BETTER_AUTH_SECRET: "workerd-secret-workerd-secret-0123456789",
          SAVVY_ANTHROPIC_API_KEY: "synthetic",
          SAVVY_DEEPGRAM_API_KEY: "synthetic",
          ADMIN_TOKEN,
        },
      },
    ],
  });
}

const delivering = harness(SENDER);
const refusing = harness("intruder@savvycopilot.com");

interface Sent {
  from: string;
  to: string;
  subject: string;
  text: string;
}

// The local send_email binding announces each message on Wrangler's log with
// its headers and the file that holds the text body.
let output = "";
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
  output += String(chunk);
  return write(chunk, ...rest);
}) as typeof process.stdout.write;

async function sent(): Promise<Sent[]> {
  const blocks = stripVTControlCharacters(output)
    .split("send_email binding called with MessageBuilder:")
    .slice(1);
  return Promise.all(
    blocks.map(async (block) => {
      const field = (name: string) =>
        new RegExp(`^(?:# )?${name}: (.+)$`, "m").exec(block)?.[1] ?? "";
      return {
        from: field("From"),
        to: field("To"),
        subject: field("Subject"),
        text: await readFile(field("Text"), "utf8"),
      };
    }),
  );
}

async function mailTo(to: string): Promise<Sent[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const messages = (await sent()).filter((message) => message.to === to);
    if (messages.length || Date.now() > deadline) return messages;
    await sleep(100);
  }
}

function auth(
  server: ReturnType<typeof harness>,
  path: string,
  body: unknown,
  cookie = "",
) {
  return server.fetch(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify(body),
  });
}

async function sql(server: ReturnType<typeof harness>, query: string) {
  const response = await server.fetch("/__probe/sql", {
    method: "POST",
    body: query,
  });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>[];
}

before(async () => {
  for (const server of [delivering, refusing]) {
    await server.listen();
    await sealEmpty(server.fetch);
  }
});
after(() => Promise.all([delivering.close(), refusing.close()]));

test("/ready reports email once the binding and sender are set", async () => {
  const ready = await delivering.fetch("/ready");
  assert.equal(((await ready.json()) as { email: boolean }).email, true);
});

test("a sign-in code reaches the recipient once and signs in", async () => {
  const email = "person@example.com";
  const requested = await auth(delivering, "/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  assert.equal(requested.status, 200, await requested.text());
  const messages = await mailTo(email);
  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.equal(message!.from, SENDER);
  assert.equal(message!.subject, "Your Savvy sign-in code");
  const otp = /^Your Savvy code is (\d{6})\. /.exec(message!.text)?.[1];
  assert.ok(otp, message!.text);
  const signed = await auth(delivering, "/sign-in/email-otp", { email, otp });
  assert.equal(signed.status, 200, await signed.text());
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const session = await delivering.fetch("/api/auth/get-session", {
    headers: { cookie },
  });
  const body = (await session.json()) as { user: { email: string } };
  assert.equal(body.user.email, email);
});

test("a team invitation sends one message with the join link", async () => {
  const email = "invitee@example.com";
  const link = "http://127.0.0.1:8788/team/join#invitation-token";
  const query = new URLSearchParams({ email, link });
  const response = await delivering.fetch(`/__probe/invite?${query}`);
  assert.equal(response.status, 200, await response.text());
  const messages = await mailTo(email);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.from, SENDER);
  assert.equal(messages[0]!.subject, "Join your team on Savvy");
  assert.ok(messages[0]!.text.includes(`\n\n${link}\n\n`), messages[0]!.text);
});

test("a refused send gives 503, logs no recipient and signs no one up", async () => {
  const email = "refused@example.com";
  refusing.clearLogs();
  const response = await auth(refusing, "/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  assert.equal(response.status, 503);
  assert.equal(
    ((await response.json()) as { message: string }).message,
    "Email delivery failed. Try again later.",
  );
  assert.deepEqual(await mailTo(email), []);
  const logs = JSON.stringify(refusing.getLogs());
  assert.match(logs, /sign-in code email failed/);
  assert.doesNotMatch(logs, /refused@example/);
  assert.deepEqual(
    await sql(refusing, `SELECT 1 FROM "user" WHERE email='${email}'`),
    [],
  );
  assert.deepEqual(
    await sql(refusing, "SELECT count FROM otp_delivery_limit"),
    [{ count: 1 }],
  );
});
