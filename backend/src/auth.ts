import { betterAuth, type BetterAuthOptions } from "better-auth";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { emailOTP } from "better-auth/plugins/email-otp";
import { jwt } from "better-auth/plugins/jwt";
import { oauthProvider } from "@better-auth/oauth-provider";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { assertDistinctDatabases, openPrivateDatabase } from "./db.js";
import nodemailer from "nodemailer";

export function createAuth(env: NodeJS.ProcessEnv = process.env) {
  assertDistinctDatabases(
    env.SAVVY_AUTH_DATABASE ?? "savvy-auth.sqlite",
    env.SAVVY_DB_PATH ?? "savvy-service.sqlite",
  );
  const baseURL = env.BETTER_AUTH_URL ?? "http://127.0.0.1:8788";
  const url = new URL(baseURL);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("Auth requires HTTPS or loopback");
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  const otpKey = hkdfSync(
    "sha256",
    env.BETTER_AUTH_SECRET,
    "",
    "savvy/email-otp/v1",
    32,
  );
  const hashOTP = async (otp: string) =>
    "v1-" +
    createHmac("sha256", Buffer.from(otpKey)).update(otp).digest("base64url");
  const db = openPrivateDatabase(
    env.SAVVY_AUTH_DATABASE ?? "savvy-auth.sqlite",
  );
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  // Separate from Better Auth migrations; never touches the service database.
  db.exec(
    "CREATE TABLE IF NOT EXISTS otp_delivery_limit (key TEXT PRIMARY KEY, last_ms INTEGER NOT NULL, window_ms INTEGER NOT NULL, count INTEGER NOT NULL)",
  );
  const reserveDelivery = db.transaction((email: string, now: number) => {
    const key = createHash("sha256").update(email).digest("hex");
    const row = db
      .prepare("SELECT * FROM otp_delivery_limit WHERE key = ?")
      .get(key) as
      { last_ms: number; window_ms: number; count: number } | undefined;
    if (
      row &&
      (now - row.last_ms < 30_000 ||
        (now - row.window_ms < 3_600_000 && row.count >= 10))
    )
      throw new APIError("TOO_MANY_REQUESTS", {
        message: "Wait before requesting another code.",
      });
    const fresh = !row || now - row.window_ms >= 3_600_000;
    db.prepare(
      "INSERT OR REPLACE INTO otp_delivery_limit VALUES (?, ?, ?, ?)",
    ).run(key, now, fresh ? now : row.window_ms, fresh ? 1 : row.count + 1);
  });
  const mail = nodemailer.createTransport({
    requireTLS: !["127.0.0.1", "localhost", "::1"].includes(
      env.SMTP_HOST ?? "",
    ),
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT ?? 587),
    secure: env.SMTP_SECURE === "true",
    ...(env.SMTP_USER
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
      : {}),
  });
  const audience = env.SAVVY_OIDC_AUDIENCE ?? "https://api.savvycopilot.com";
  const clientId = env.SAVVY_OIDC_CLIENT_ID ?? "savvy-desktop";
  const hashToken = (token: string) =>
    createHash("sha256").update(token).digest("base64url");
  const options = {
    appName: "Savvy",
    baseURL,
    secret: env.BETTER_AUTH_SECRET,
    database: db,
    emailAndPassword: { enabled: false },
    // The browser session only bridges sign-in to the desktop's OAuth tokens.
    session: { expiresIn: 3600, updateAge: 3600 },
    account: { encryptOAuthTokens: true },
    trustedOrigins: [url.origin],
    advanced: { ipAddress: { ipAddressHeaders: ["x-savvy-client-ip"] } },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 3 },
        "/sign-in/email-otp": { window: 60, max: 10 },
      },
    },
    socialProviders:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              scope: ["openid", "email", "profile"],
            },
          }
        : {},
    disabledPaths: [
      "/token",
      "/email-otp/request-password-reset",
      "/forget-password/email-otp",
      "/email-otp/reset-password",
      "/email-otp/request-email-change",
      "/email-otp/change-email",
      "/email-otp/verify-email",
      "/email-otp/check-verification-otp",
    ],
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (
          ctx.path !== "/oauth2/revoke" ||
          ctx.body?.client_id !== clientId ||
          typeof ctx.body?.token !== "string"
        )
          return;
        const refresh = await ctx.context.adapter.findOne<{
          sessionId: string | null;
          revoked: Date | null;
        }>({
          model: "oauthRefreshToken",
          where: [
            { field: "token", value: hashToken(ctx.body.token) },
            { field: "clientId", value: clientId },
          ],
        });
        if (!refresh?.revoked || !refresh.sessionId) return;
        const session = await ctx.context.adapter.findOne<{ token: string }>({
          model: "session",
          where: [{ field: "id", value: refresh.sessionId }],
        });
        if (session)
          await ctx.context.internalAdapter.deleteSession(session.token);
      }),
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/email-otp/send-verification-otp") {
          const email = ctx.body?.email;
          if (
            typeof email !== "string" ||
            email.length > 254 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
            ctx.body?.type !== "sign-in"
          )
            throw new APIError("BAD_REQUEST", {
              message: "Enter a valid email address.",
            });

          reserveDelivery(email.trim().toLowerCase(), Date.now());
        }
      }),
    },
    plugins: [
      {
        id: "await-delivery",
        init: () => ({
          context: {
            // This server must report SMTP/cooldown failures to the sign-in page.
            runInBackgroundOrAwait: async (
              promise: Promise<unknown> | void,
            ) => {
              await promise;
            },
          },
        }),
      },
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 3,
        storeOTP: { hash: hashOTP },
        resendStrategy: "rotate",
        async sendVerificationOTP({ email, otp, type }, ctx) {
          if (type !== "sign-in")
            throw new APIError("BAD_REQUEST", {
              message: "Unsupported email operation.",
            });
          // Only send-verification-otp reserves delivery (the before hook) ahead
          // of OTP rotation; refuse every other caller.
          if (ctx?.path !== "/email-otp/send-verification-otp")
            throw new APIError("BAD_REQUEST", {
              message: "Unsupported email operation.",
            });
          if (!env.SMTP_HOST || !env.SMTP_FROM)
            throw new APIError("SERVICE_UNAVAILABLE", {
              message: "Email delivery is unavailable. Try again later.",
            });
          try {
            await mail.sendMail({
              from: env.SMTP_FROM,
              to: email,
              subject: "Your Savvy sign-in code",
              text: `Your Savvy code is ${otp}. It expires in 10 minutes. If you did not request it, ignore this email.`,
            });
          } catch (error) {
            const { code, responseCode, command } = error as {
              code?: string;
              responseCode?: number;
              command?: string;
            };
            console.error("sign-in code email failed", {
              code,
              responseCode,
              command,
            });
            throw new APIError("SERVICE_UNAVAILABLE", {
              message: "Email delivery failed. Try again later.",
            });
          }
        },
      }),
      jwt({
        jwt: { issuer: baseURL },
        jwks: { keyPairConfig: { alg: "RS256" } },
      }),
      oauthProvider({
        storeTokens: { hash: hashToken },
        loginPage: "/sign-in",
        signup: { page: "/sign-up" },
        consentPage: "/consent",
        customAccessTokenClaims: ({ user }) =>
          user
            ? {
                name: user.name,
                email: user.emailVerified ? user.email : undefined,
                email_verified: user.emailVerified,
              }
            : {},
        scopes: ["openid", "email", "profile", "offline_access"],
        resources: [audience],
        grantTypes: ["authorization_code", "refresh_token"],
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        clientPrivileges: () => false,
        cachedTrustedClients: new Set([clientId]),
        accessTokenExpiresIn: 600,
        codeExpiresIn: 120,
        refreshTokenReuseInterval: 0,
      }),
    ],
  } satisfies BetterAuthOptions;
  let auth: ReturnType<typeof buildAuth> | undefined;
  const buildAuth = () => betterAuth(options);
  return {
    get auth() {
      return (auth ??= buildAuth());
    },
    options,
    audience,
    db,
    clientId,
    reserveDelivery,
    hashOTP,
  };
}
