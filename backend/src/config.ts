import { isIP } from "node:net";

export function isLoopback(host: string) {
  const address = host.replace(/^\[|\]$/g, "");
  return (
    address === "localhost" ||
    address === "::1" ||
    (isIP(address) === 4 && address.startsWith("127."))
  );
}

export function configuration(env: NodeJS.ProcessEnv = process.env) {
  const required = (name: string) => {
    const value = env[name];
    if (!value)
      throw new Error(`Missing required environment variable ${name}`);
    return value;
  };
  const issuer = env.BETTER_AUTH_URL ?? "http://127.0.0.1:8788";
  if (env.SAVVY_OIDC_ISSUER && env.SAVVY_OIDC_ISSUER !== issuer)
    throw new Error(
      "The backend must retain the configured Better Auth issuer",
    );
  const config = {
    issuer,
    audience: env.SAVVY_OIDC_AUDIENCE ?? "https://api.savvy.alamaslabs.com",
    serviceDatabase: env.SAVVY_DB_PATH ?? "savvy-service.sqlite",
    bind: env.SAVVY_HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8788),
    aiBaseUrl: env.SAVVY_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    aiKey: required("SAVVY_ANTHROPIC_API_KEY"),
    aiModel: env.SAVVY_AI_MODEL ?? "claude-sonnet-5",
    deepgramUrl: env.SAVVY_DEEPGRAM_URL ?? "wss://api.deepgram.com/v1/listen",
    deepgramKey: required("SAVVY_DEEPGRAM_API_KEY"),
    stripeBaseUrl: env.SAVVY_STRIPE_BASE_URL ?? "https://api.stripe.com",
    stripeKey: required("SAVVY_STRIPE_SECRET_KEY"),
    stripeWebhookSecret: required("SAVVY_STRIPE_WEBHOOK_SECRET"),
    stripePriceMonthly: required("SAVVY_STRIPE_PRICE_MONTHLY"),
    stripePricePack: required("SAVVY_STRIPE_PRICE_PACK"),
    checkoutReturnUrl:
      env.SAVVY_CHECKOUT_RETURN_URL ?? "https://savvy.local/checkout-complete",
    fixtures: env.SAVVY_DEV_FIXTURES === "1",
  };
  if (
    !isIP(config.bind) ||
    !Number.isInteger(config.port) ||
    config.port < 0 ||
    config.port > 65535
  )
    throw new Error("Invalid backend listen address");
  if (config.fixtures && !isLoopback(config.bind))
    throw new Error("Fixtures require a loopback listener");
  for (const raw of [
    config.issuer,
    config.aiBaseUrl,
    config.deepgramUrl,
    config.stripeBaseUrl,
    config.checkoutReturnUrl,
  ]) {
    const url = new URL(raw);
    const local = isLoopback(url.hostname);
    if (
      url.username ||
      url.password ||
      url.hash ||
      !["https:", "wss:", "http:", "ws:"].includes(url.protocol) ||
      (["http:", "ws:"].includes(url.protocol) && !local) ||
      (config.fixtures && !local)
    )
      throw new Error(
        "Service URLs must be secure; fixtures require loopback upstreams",
      );
  }
  return config;
}

export type Config = ReturnType<typeof configuration>;

export function systemClock() {
  const epoch = BigInt(Date.now());
  const start = process.hrtime.bigint();
  return () => epoch + (process.hrtime.bigint() - start) / 1_000_000n;
}
