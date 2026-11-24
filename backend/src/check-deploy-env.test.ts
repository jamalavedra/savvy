import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REQUIRED_SECRETS,
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
