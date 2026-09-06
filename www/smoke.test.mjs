import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

test("static export has metadata, FAQ answers and referenced assets", async () => {
  const html = await readFile("out/index.html", "utf8");
  assert.match(html, /rel="canonical" href="https:\/\/savvycopilot\.com\/"/);
  assert.equal([...html.matchAll(/<details[ >]/g)].length, 8);
  assert.match(html, /<summary[^>]*>Where does my data go\?/);
  for (const [, asset] of html.matchAll(/(?:src|poster)="(\/[^"?]+)"/g)) {
    await access(`out${asset}`);
  }
  for (const file of ["robots.txt", "sitemap.xml"]) {
    assert.match(await readFile(`out/${file}`, "utf8"), /https:\/\/savvycopilot\.com/);
  }
  await access("out/404.html");
});
