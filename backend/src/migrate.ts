import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "./auth.js";
export async function migrate(instance: ReturnType<typeof createAuth>) {
  const { clientId } = instance;
  const migration = await getMigrations(instance.options);
  await migration.runMigrations();
  const context = await instance.auth.$context;
  const existing = await context.adapter.findOne({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
  });
  if (!existing)
    await context.adapter.create({
      model: "oauthClient",
      data: {
        clientId,
        name: "Savvy",
        applicationType: "native",
        redirectUris: ["com.alamaslabs.savvy:/oauth/callback"],
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        scopes: ["openid", "email", "profile", "offline_access"],
        skipConsent: true,
        requirePKCE: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  const audience = instance.audience;
  const resource = await context.adapter.findOne<{ id: string }>({
    model: "oauthResource",
    where: [{ field: "identifier", value: audience }],
  });
  if (!resource) throw new Error("OAuth resource was not initialized");
  const link = await context.adapter.findOne({
    model: "oauthClientResource",
    where: [
      { field: "clientId", value: clientId },
      { field: "resourceId", value: audience },
    ],
  });
  if (!link)
    await context.adapter.create({
      model: "oauthClientResource",
      data: { clientId, resourceId: audience, createdAt: new Date() },
    });
}
if (/\/migrate\.(ts|js)$/.test(process.argv[1] ?? "")) {
  const instance = createAuth();
  await migrate(instance);
  instance.db.close();
}
