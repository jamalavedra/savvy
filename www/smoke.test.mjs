import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";
import { getAllPosts } from "./src/lib/blog.ts";
import { CONSENT_YEAR, readConsent } from "./src/lib/consent.ts";
import { SITE_URL } from "./src/lib/constants.ts";

test("static export has metadata, FAQ answers and referenced assets", async () => {
  const html = await readFile("out/index.html", "utf8");
  assert.match(html, /rel="canonical" href="https:\/\/savvycopilot\.com\/"/);
  assert.equal([...html.matchAll(/<details[ >]/g)].length, 8);
  assert.match(html, /<button[^>]*disabled=""[^>]*>.*?Windows coming soon<\/button>/);
  assert.equal([...html.matchAll(/Reads your files first\.<br\//g)].length, 1);
  assert.match(html, /<summary[^>]*>Where does my data go\?/);
  for (const [, asset] of html.matchAll(/(?:src|poster)="(\/[^"?]+)"/g)) {
    await access(`out${asset}`);
  }
  for (const file of ["robots.txt", "sitemap.xml"]) {
    assert.match(await readFile(`out/${file}`, "utf8"), /https:\/\/savvycopilot\.com/);
  }
  await access("out/404.html");
});

test("analytics requires a valid unexpired explicit choice", () => {
  const now = 1000;
  for (const raw of [
    null,
    "bad json",
    "null",
    "true",
    "{}",
    '{"allowed":"true","expires":2000}',
    '{"allowed":true,"expires":1000}',
    JSON.stringify({ allowed: true, expires: now + CONSENT_YEAR + 1 }),
  ]) {
    assert.equal(readConsent(raw, now), null);
  }
  for (const allowed of [true, false]) {
    assert.deepEqual(readConsent(JSON.stringify({ allowed, expires: 2000 }), now), {
      allowed,
      expires: 2000,
    });
  }
});

test("privacy notice is linked and analytics is absent from initial HTML", async () => {
  const home = await readFile("out/index.html", "utf8");
  const privacy = await readFile("out/privacy/index.html", "utf8");
  assert.match(home, /href="\/privacy\/"/);
  assert.doesNotMatch(home, /<script[^>]+src="https:\/\/analytics\.jamalavedra\.com/);
  assert.match(privacy, /rel="canonical" href="https:\/\/savvycopilot\.com\/privacy\/"/);
  assert.match(privacy, /Alamas Labs, Inc\./);
  assert.match(privacy, /mailto:hello@savvycopilot\.com/);
  assert.doesNotMatch(privacy, /Draft for review|\[Confirm|\[public privacy/);
});

test("static export includes the blog and generated llms.txt", async () => {
  const posts = getAllPosts();
  assert.equal(posts.length, 5);
  const llms = await readFile("out/llms.txt", "utf8");
  const sitemap = await readFile("out/sitemap.xml", "utf8");
  await access("out/blog/index.html");
  for (const post of posts) {
    await access(`out/blog/${post.slug}/index.html`);
    const url = `${SITE_URL}/blog/${post.slug}/`;
    assert.ok(llms.includes(`[${post.title}](${url})`));
    assert.ok(sitemap.includes(url));
  }
  for (const caveat of [
    "macOS 13+",
    "Apple Silicon",
    "no hidden mode",
    "no offline transcription",
    "30 days",
    "startup",
    "whole brief",
    "recent relevant transcript turns",
    "mip_opt_out=true",
  ]) {
    assert.ok(llms.includes(caveat), `Missing caveat: ${caveat}`);
  }
});
