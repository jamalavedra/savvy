import assert from "node:assert/strict";
import { test } from "node:test";
import { teamReturn } from "./browser-navigation.js";
test("team continuation accepts only team pages and cannot intercept desktop OAuth", () => {
  for (const path of ["/team", "/team/join"])
    assert.equal(
      teamReturn(
        new URL(
          `https://savvy.test/sign-in?returnTo=${encodeURIComponent(path)}`,
        ),
        null,
      ),
      path,
    );
  for (const path of [
    "https://foreign.test",
    "//foreign.test",
    "/team/../sign-in",
    "/team#secret",
    "/team?token=secret",
  ])
    assert.equal(
      teamReturn(
        new URL(
          `https://savvy.test/sign-in?returnTo=${encodeURIComponent(path)}`,
        ),
        "/team",
      ),
      null,
    );
  for (const key of [
    "oauth_query",
    "client_id",
    "redirect_uri",
    "state",
    "code_challenge",
  ])
    assert.equal(
      teamReturn(
        new URL(`https://savvy.test/sign-in?${key}=native&returnTo=/team`),
        "/team/join",
      ),
      null,
    );
  assert.equal(
    teamReturn(new URL("https://savvy.test/sign-in"), "/team/join"),
    "/team/join",
  );
  assert.equal(
    teamReturn(new URL("https://savvy.test/sign-in"), "https://foreign.test"),
    null,
  );
});
