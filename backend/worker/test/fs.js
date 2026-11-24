import schema from "../../src/service-schema.sql";
import capabilities from "../../src/service-capabilities.json";
import providers from "../../src/source-providers.json";
import contracts from "../../src/provider-contracts.json";
import catalog from "../../../config/managed-catalog.json";

const fs = process.getBuiltinModule("node:fs");
const assets = {
  "service-schema.sql": schema,
  "service-capabilities.json": JSON.stringify(capabilities),
  "source-providers.json": JSON.stringify(providers),
  "provider-contracts.json": JSON.stringify(contracts),
  "managed-catalog.json": JSON.stringify(catalog),
};

export function readFileSync(path, options) {
  const name = String(path instanceof URL ? path.pathname : path)
    .split("/")
    .pop();
  return name in assets ? assets[name] : fs.readFileSync(path, options);
}

export const {
  openSync,
  closeSync,
  fchmodSync,
  fstatSync,
  constants,
  realpathSync,
  statSync,
  lstatSync,
  readlinkSync,
  existsSync,
  writeFileSync,
  promises,
} = fs;
export default { ...fs, readFileSync };
