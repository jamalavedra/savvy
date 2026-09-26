// Test-only migration driver. Never imported by the backend entry point.
import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { symmetricEncrypt } from "better-auth/crypto";
import { createAuth } from "./auth.js";
import { migrate } from "./migrate.js";

if (process.env.SAVVY_DEV_FIXTURES !== "1")
  throw new Error("Reference seed requires fixtures");
const instance = createAuth();
try {
  await migrate(instance);
  const keys = JSON.parse(
    readFileSync(
      new URL(
        "../../backend-migration/fixtures/test-issuer-jwks.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const privateKey = createPrivateKey(
    readFileSync(
      new URL(
        "../../backend-migration/fixtures/test-issuer-rsa.pem",
        import.meta.url,
      ),
    ),
  ).export({ format: "jwk" });
  const encrypted = JSON.stringify(
    await symmetricEncrypt({
      key: process.env.BETTER_AUTH_SECRET!,
      data: JSON.stringify(privateKey),
    }),
  );
  instance.db
    .prepare(
      "INSERT INTO jwks(id,publicKey,privateKey,createdAt,alg) VALUES(?,?,?,?,?)",
    )
    .run(
      keys.keys[0].kid,
      JSON.stringify(keys.keys[0]),
      encrypted,
      Date.now(),
      "RS256",
    );
} finally {
  instance.db.close();
}
