import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { unstable_readConfig, type Unstable_Config } from "wrangler";

/**
 * Secrets a staging or production Worker needs to boot and be operated.
 * `configuration()` needs the Fireworks, Deepgram and four Stripe names on a
 * public issuer; `createAuth()` needs BETTER_AUTH_SECRET; the issuer is
 * BETTER_AUTH_URL; the deploy's export and the seal need ADMIN_TOKEN. The OIDC
 * audience and client id default to production values, so staging must set them.
 */
export const REQUIRED_SECRETS = [
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "SAVVY_FIREWORKS_API_KEY",
  "SAVVY_DEEPGRAM_API_KEY",
  "SAVVY_STRIPE_SECRET_KEY",
  "SAVVY_STRIPE_WEBHOOK_SECRET",
  "SAVVY_STRIPE_PRICE_MONTHLY",
  "SAVVY_STRIPE_PRICE_PACK",
  "ADMIN_TOKEN",
  "SAVVY_OIDC_AUDIENCE",
  "SAVVY_OIDC_CLIENT_ID",
] as const;

export function missingSecrets(listed: readonly string[]) {
  return REQUIRED_SECRETS.filter((name) => !listed.includes(name));
}

/**
 * Email codes are the only sign-in besides optional Google, so a public Worker
 * needs the EMAIL binding and a SAVVY_EMAIL_FROM var the binding may send from.
 */
export function missingMail(
  config: Pick<Unstable_Config, "send_email" | "vars">,
) {
  const from = config.vars.SAVVY_EMAIL_FROM;
  if (typeof from !== "string" || !from) return "the SAVVY_EMAIL_FROM var";
  const binding = config.send_email.find(({ name }) => name === "EMAIL");
  if (!binding) return "the send_email binding EMAIL";
  if (!binding.allowed_sender_addresses?.includes(from))
    return `${from} in EMAIL's allowed_sender_addresses`;
  return null;
}

/** Reads the names from `wrangler secret list --format json` output. */
export function secretNames(json: string) {
  const parsed: unknown = JSON.parse(json);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => typeof entry?.name === "string")
  )
    throw new Error("wrangler secret list did not return [{ name }]");
  return (parsed as { name: string }[]).map((entry) => entry.name);
}

if (
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
) {
  try {
    const [env, ...extra] = process.argv.slice(2);
    if (!["staging", "production"].includes(env ?? "") || extra.length)
      throw new Error("Usage: check-deploy-env (staging | production)");
    const listed = secretNames(
      execFileSync(
        "wrangler",
        ["secret", "list", "--env", env!, "--format", "json"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      ),
    );
    const missing = missingSecrets(listed);
    if (missing.length)
      throw new Error(
        `${env} is missing secrets: ${missing.join(", ")}. Set each with wrangler secret put <NAME> --env ${env}`,
      );
    const mail = missingMail(unstable_readConfig({ env: env! }));
    if (mail)
      throw new Error(
        `${env} cannot send sign-in codes: wrangler.jsonc env.${env} lacks ${mail}`,
      );
    console.log(
      `${env} has all ${REQUIRED_SECRETS.length} required secrets and mail`,
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Secrets preflight failed",
    );
    process.exitCode = 1;
  }
}
