import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { faqItems } from "./src/content/faq.ts";
import { getAllPosts } from "./src/lib/blog.ts";
import { CONSENT_YEAR, readConsent } from "./src/lib/consent.ts";
import { SITE_URL } from "./src/lib/constants.ts";
import worker from "./worker.js";

test("static export has metadata, FAQ answers and referenced assets", async () => {
  const html = await readFile("out/index.html", "utf8");
  assert.match(html, /rel="canonical" href="https:\/\/www\.savvycopilot\.com\/"/);
  assert.equal([...html.matchAll(/<details[ >]/g)].length, faqItems.length);
  assert.match(html, /href="https:\/\/github\.com\/jamalavedra\/savvy\/releases\/latest"/);
  for (const app of ["google-meet", "microsoft-teams", "zoom"]) {
    assert.match(html, new RegExp(`/images/logos/${app}\\.svg`));
  }
  assert.match(html, /<summary[^>]*>Where does my data go\?/);
  for (const [, asset] of html.matchAll(/(?:src|poster)="(\/[^"?]+)"/g)) {
    await access(`out${asset}`);
  }
  for (const file of ["robots.txt", "sitemap.xml"]) {
    assert.match(await readFile(`out/${file}`, "utf8"), /https:\/\/www\.savvycopilot\.com/);
  }
  await access("out/404.html");
});

test("every exported page has a keyboard skip link and focusable main content", async () => {
  const pages = (await readdir("out", { recursive: true })).filter((file) =>
    file.endsWith(".html"),
  );
  assert.ok(pages.length > 0);
  for (const page of pages) {
    const html = await readFile(`out/${page}`, "utf8");
    assert.match(html, /<a[^>]*href="#main"[^>]*>Skip to content<\/a>/, page);
    assert.match(html, /<main[^>]*id="main"[^>]*tabindex="-1"/, page);
  }
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
  assert.match(privacy, /rel="canonical" href="https:\/\/www\.savvycopilot\.com\/privacy\/"/);
  assert.match(privacy, /Alamas Labs, Inc\./);
  assert.match(privacy, /mailto:hello@savvycopilot\.com/);
  assert.doesNotMatch(privacy, /Draft for review|\[Confirm|\[public privacy/);
  assert.doesNotMatch(privacy, /does not describe a future managed subscription/);
  for (const processing of [
    "Managed accounts and payments",
    "Managed meeting processing",
    "Deepgram",
    "Fireworks",
    "Stripe",
    "no automatic expiry",
  ])
    assert.ok(privacy.includes(processing), `Missing managed processing disclosure: ${processing}`);
});

test("static export includes the blog and generated llms.txt", async () => {
  const posts = getAllPosts();
  assert.equal(posts.length, 13);
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

test("buyer guides are linked from home and every internal page link resolves", async () => {
  const pages = (await readdir("out", { recursive: true })).filter((file) =>
    file.endsWith(".html"),
  );
  const htmlByPath = new Map(
    await Promise.all(pages.map(async (file) => [file, await readFile(`out/${file}`, "utf8")])),
  );
  const home = htmlByPath.get("index.html");
  for (const slug of [
    "what-real-time-meeting-assistant-means",
    "meeting-prep",
    "local-first-meeting-assistant-vs-meeting-bots",
  ]) {
    assert.ok(home.includes(`href="/blog/${slug}/"`), slug);
  }
  for (const [page, html] of htmlByPath) {
    for (const [, href] of html.matchAll(/<a\b[^>]*href="([^"]+)"/g)) {
      const url = new URL(href, `${SITE_URL}/${page.replace(/index\.html$/, "")}`);
      if (url.origin !== SITE_URL) continue;
      const target = url.pathname.endsWith("/")
        ? `${url.pathname}index.html`
        : path.extname(url.pathname)
          ? url.pathname
          : `${url.pathname}/index.html`;
      const file = target.slice(1);
      await access(`out/${file}`).catch(() => assert.fail(`${page}: broken link ${href}`));
      if (url.hash) {
        assert.ok(
          htmlByPath.get(file)?.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`),
          `${page}: missing anchor ${href}`,
        );
      }
    }
  }
});

test("articles keep publication dates and expose consistent revision metadata", async () => {
  const sitemap = await readFile("out/sitemap.xml", "utf8");
  for (const post of getAllPosts()) {
    const html = await readFile(`out/blog/${post.slug}/index.html`, "utf8");
    const url = `${SITE_URL}/blog/${post.slug}/`;
    assert.ok(html.includes(`rel="canonical" href="${url}"`), post.slug);
    const graphs = [
      ...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs),
    ].flatMap(([, json]) => JSON.parse(json)["@graph"] ?? []);
    const article = graphs.find((item) => item["@type"] === "BlogPosting");
    assert.equal(article?.mainEntityOfPage["@id"], url);
    assert.equal(article?.datePublished, post.date);
    assert.equal(article?.dateModified, post.updated);
    assert.ok(html.includes(`property="article:modified_time" content="${post.updated}"`));
    assert.ok(html.includes(`href="/pricing/"`));
    const entry = sitemap.split("<url>").find((item) => item.includes(`<loc>${url}</loc>`));
    assert.ok(entry?.includes(`<lastmod>${post.updated}T00:00:00.000Z</lastmod>`), post.slug);
    if (post.updated !== post.date) {
      assert.ok(html.includes(`Updated <time dateTime="${post.updated}"`), post.slug);
    }
  }
});

test("article revisions default to publication and reject invalid update dates", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "savvy-blog-"));
  try {
    const posts = path.join(directory, "src/content/blog");
    await mkdir(posts, { recursive: true });
    const modulePath = new URL("./src/lib/blog.ts", import.meta.url).href;
    for (const [update, expected] of [
      ["", "2026-09-01"],
      ["updated: 2026-10-29\n", "2026-10-29"],
      ["updated: yesterday\n", "updated must be a valid YYYY-MM-DD date"],
      ["updated: 2026-02-30\n", "updated must be a valid YYYY-MM-DD date"],
      ["updated: 2026-08-01\n", "updated must not precede date"],
    ]) {
      await writeFile(
        path.join(posts, "example.md"),
        `---\ntitle: Example\ndescription: Synthetic fixture\ndate: 2026-09-01\n${update}---\nBody.\n`,
      );
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { getAllPosts } from ${JSON.stringify(modulePath)}; console.log(getAllPosts()[0].updated);`,
        ],
        { cwd: directory, encoding: "utf8" },
      );
      assert.equal(result.status, expected.startsWith("2026") ? 0 : 1);
      assert.ok(`${result.stdout}${result.stderr}`.includes(expected));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed pricing uses the shared catalog and return page only requests refresh", async () => {
  const catalog = JSON.parse(await readFile("../config/managed-catalog.json", "utf8"));
  const pricing = await readFile("out/pricing/index.html", "utf8");
  const returned = await readFile("out/checkout-complete/index.html", "utf8");
  const text = pricing.replace(/<[^>]*>/g, "");
  for (const offer of Object.values(catalog)) {
    assert.ok(text.includes(String(offer.amountCents / 100)));
    assert.ok(text.includes(`${offer.hours} meeting hours and ${offer.briefs} briefs`));
  }
  assert.match(pricing, /Your own providers/);
  assert.match(pricing, /nothing to Savvy/);
  assert.match(pricing, /No scheduled expiry/);
  assert.match(pricing, /end of the paid period/);
  assert.match(returned, /This page does not confirm payment/);
  assert.match(returned, /Refresh account/);
  assert.doesNotMatch(returned, /Payment successful|purchase complete|checkout\.stripe\.com/);
});

test("worker redirects the apex domain to www with a 308", async () => {
  const env = { ASSETS: { fetch: () => new Response("asset") } };
  const apex = await worker.fetch(new Request("https://savvycopilot.com/blog/?x=1"), env);
  assert.equal(apex.status, 308);
  assert.equal(apex.headers.get("location"), `${SITE_URL}/blog/?x=1`);
  assert.equal(apex.headers.get("strict-transport-security"), "max-age=31536000");
  const www = await worker.fetch(new Request(`${SITE_URL}/`), env);
  assert.equal(await www.text(), "asset");
  assert.equal(www.headers.get("strict-transport-security"), "max-age=31536000");
});
