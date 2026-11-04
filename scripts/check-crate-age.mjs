#!/usr/bin/env node
// Cargo has no minimumReleaseAge, so this enforces the same 7-day cooldown pnpm uses
// on every crates.io package a change adds to Cargo.lock.
// Usage: node scripts/check-crate-age.mjs <base-git-ref>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MIN_AGE_DAYS = 7;
// Urgent security fixes that cannot wait out the cooldown. Each entry names the advisory
// it clears; delete it once the release is older than MIN_AGE_DAYS. Example:
//   ["zip@9.0.5", "fixes GHSA-m665-v7pm-7grj; clears cooldown 2026-10-24"],
const EXCEPTIONS = new Map([]);

function registryPackages(lock) {
  const packages = new Set();
  for (const block of lock.split("[[package]]").slice(1)) {
    const name = block.match(/^name = "(.+)"$/m)?.[1];
    const version = block.match(/^version = "(.+)"$/m)?.[1];
    if (name && version && block.includes('source = "registry+'))
      packages.add(`${name}@${version}`);
  }
  return packages;
}

const base = process.argv[2];
if (!base) throw new Error("usage: check-crate-age.mjs <base-git-ref>");
const before = registryPackages(
  execFileSync("git", ["show", `${base}:Cargo.lock`], { encoding: "utf8" }),
);
const added = [...registryPackages(readFileSync("Cargo.lock", "utf8"))].filter(
  (id) => !before.has(id),
);
const failures = [];
for (const id of added) {
  // crates.io's crawler policy allows one request per second.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const [name, version] = id.split("@");
  const response = await fetch(
    `https://crates.io/api/v1/crates/${name}/${version}`,
    { headers: { "User-Agent": "savvy-crate-age-check" } },
  );
  if (!response.ok)
    throw new Error(`crates.io lookup for ${id} failed: ${response.status}`);
  const { version: info } = await response.json();
  const ageDays = (Date.now() - Date.parse(info.created_at)) / 86_400_000;
  if (ageDays >= MIN_AGE_DAYS) continue;
  if (EXCEPTIONS.has(id)) console.log(`exception ${id}: ${EXCEPTIONS.get(id)}`);
  else failures.push(`${id} is ${ageDays.toFixed(1)} days old`);
}
console.log(`checked ${added.length} new crate versions against ${base}`);
if (failures.length) {
  console.error(
    `Crates younger than ${MIN_AGE_DAYS} days (pin an older version or add a ` +
      `justified exception):\n  ${failures.join("\n  ")}`,
  );
  process.exit(1);
}
