#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";

const [mode, current, release, database, ...extra] = process.argv.slice(2);
let temporary;
try {
  if (
    !["check", "switch"].includes(mode) ||
    !current ||
    !release ||
    !database ||
    extra.length
  )
    throw new Error(
      "Usage: savvy-release <check|switch> <current-link> <candidate-release> <service.sqlite>",
    );
  const target = realpathSync(release);
  let controller = realpathSync(current);
  if (!existsSync(join(controller, "backend/build/rollback-preflight.js")))
    controller = target;
  execFileSync(
    process.execPath,
    [
      join(controller, "backend/build/rollback-preflight.js"),
      "--db",
      resolve(database),
      "--candidate",
      join(target, "backend/build/service-capabilities.json"),
    ],
    { stdio: "inherit" },
  );
  if (mode === "switch") {
    temporary = `${resolve(current)}.next-${randomUUID()}`;
    symlinkSync(target, temporary, "dir");
    renameSync(temporary, current);
  }
} catch {
  console.error("Release guard failed; no release switch was performed.");
  process.exitCode = 1;
} finally {
  if (temporary) rmSync(temporary, { force: true });
}
