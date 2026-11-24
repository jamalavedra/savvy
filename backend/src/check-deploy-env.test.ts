import assert from "node:assert/strict";
import { test } from "node:test";
import { unstable_readConfig } from "wrangler";
import {
  REQUIRED_SECRETS,
  missingMail,
  missingSecrets,
  secretNames,
} from "./check-deploy-env.js";
import { configuration } from "./config.js";

const placeholders = (names: readonly string[]) =>
  Object.fromEntries(
    names.map((name) => [
      name,
      name === "BETTER_AUTH_URL" ? "https://api.example.test" : "x".repeat(32),
    ]),
  );

test("the preflight flags each missing secret by name", () => {
  const listed = secretNames(
    JSON.stringify(
      REQUIRED_SECRETS.filter((name) => name !== "SAVVY_DEEPGRAM_API_KEY").map(
        (name) => ({ name, type: "secret_text" }),
      ),
    ),
  );
  assert.deepEqual(missingSecrets(listed), ["SAVVY_DEEPGRAM_API_KEY"]);
  assert.deepEqual(missingSecrets([...REQUIRED_SECRETS]), []);
  assert.deepEqual(missingSecrets([]), [...REQUIRED_SECRETS]);
  assert.throws(() => secretNames('{"name":"x"}'), /\[\{ name \}\]/);
});

test("the required secrets are enough for a public, metered configuration", () => {
  const config = configuration(placeholders(REQUIRED_SECRETS));
  assert.equal(config.issuer, "https://api.example.test");
  assert.equal(config.aiProvider, "fireworks");
  assert.notEqual(config.billing, null);
});

test("configuration refuses to boot without any secret it reads", () => {
  for (const name of REQUIRED_SECRETS.filter((name) =>
    name.startsWith("SAVVY_"),
  ))
    assert.throws(
      () =>
        configuration(
          placeholders(REQUIRED_SECRETS.filter((other) => other !== name)),
        ),
      /Missing required|Stripe is not configured/,
      name,
    );
});

test("staging and production each carry their own mail binding and sender", () => {
  const config = (env: string) =>
    unstable_readConfig({
      config: new URL("../wrangler.jsonc", import.meta.url).pathname,
      env,
    });
  for (const env of ["staging", "production"])
    assert.equal(missingMail(config(env)), null, env);
  const production = config("production");
  const mail = (send_email: typeof production.send_email, from?: string) =>
    missingMail({ send_email, vars: from ? { SAVVY_EMAIL_FROM: from } : {} });
  assert.equal(mail(production.send_email), "the SAVVY_EMAIL_FROM var");
  assert.equal(
    mail([], "noreply@savvycopilot.com"),
    "the send_email binding EMAIL",
  );
  assert.equal(
    mail(production.send_email, "other@savvycopilot.com"),
    "other@savvycopilot.com in EMAIL's allowed_sender_addresses",
  );
});
