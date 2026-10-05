// Test-only seed that installs the load test's throwaway issuer key.
// Never imported by the backend entry point.
import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { symmetricEncrypt } from "better-auth/crypto";
import { createAuth } from "./auth.js";
import { migrate } from "./migrate.js";
import { isLoopback } from "./config.js";

if (
  process.env.SAVVY_DEV_FIXTURES !== "1" ||
  !process.env.SAVVY_FIXTURE_KEY ||
  !isLoopback(
    new URL(process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8788").hostname,
  )
)
  throw new Error(
    "The fixture seed requires SAVVY_DEV_FIXTURES=1, SAVVY_FIXTURE_KEY and a loopback BETTER_AUTH_URL",
  );
const instance = createAuth();
try {
  await migrate(instance);
  const key = createPrivateKey(readFileSync(process.env.SAVVY_FIXTURE_KEY));
  const publicKey = {
    ...createPublicKey(key).export({ format: "jwk" }),
    use: "sig",
    alg: "RS256",
    kid: "savvy-test-key-1",
  };
  const encrypted = JSON.stringify(
    await symmetricEncrypt({
      key: process.env.BETTER_AUTH_SECRET!,
      data: JSON.stringify(key.export({ format: "jwk" })),
    }),
  );
  instance.db
    .prepare(
      "INSERT INTO jwks(id,publicKey,privateKey,createdAt,alg) VALUES(?,?,?,?,?)",
    )
    .run(
      publicKey.kid,
      JSON.stringify(publicKey),
      encrypted,
      Date.now(),
      "RS256",
    );
} finally {
  instance.db.close();
}
