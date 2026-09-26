import { copyFileSync } from "node:fs";

copyFileSync(
  new URL("../src/service-schema.sql", import.meta.url),
  new URL("../build/service-schema.sql", import.meta.url),
);
copyFileSync(
  new URL("../src/provider-contracts.json", import.meta.url),
  new URL("../build/provider-contracts.json", import.meta.url),
);
