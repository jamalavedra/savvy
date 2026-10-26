import { expect, test } from "vitest";
import { publicUpdater } from "./public-updater.mjs";

test("public updater avoids API downloads without changing signatures or the source manifest", () => {
  const asset = {
    url: "https://api.github.com/repos/jamalavedra/savvy/releases/assets/123",
    browser_download_url:
      "https://github.com/jamalavedra/savvy/releases/download/v0.1.3/Savvy.app.tar.gz",
  };
  const manifest = {
    version: "0.1.3",
    platforms: {
      "darwin-aarch64": { url: asset.url, signature: "signed-archive" },
    },
  };
  const result = publicUpdater(manifest, [asset], "v0.1.3");
  expect(result.platforms["darwin-aarch64"]).toEqual({
    url: asset.browser_download_url,
    signature: "signed-archive",
  });
  expect(result.version).toBe(manifest.version);
  expect(manifest.platforms["darwin-aarch64"].url).toBe(asset.url);
  expect(publicUpdater(result, [asset], "v0.1.3")).toEqual(result);
  expect(() => publicUpdater(manifest, [], "v0.1.3")).toThrow(
    "unknown release asset",
  );
});

test("draft asset links use the final release tag and can be processed again", () => {
  const asset = {
    url: "https://api.github.com/repos/jamalavedra/savvy/releases/assets/456",
    browser_download_url:
      "https://github.com/jamalavedra/savvy/releases/download/untagged-abc/Savvy_0.1.4_x64-setup.exe",
  };
  for (const sourceUrl of [asset.url, asset.browser_download_url]) {
    const manifest = {
      version: "0.1.4",
      platforms: {
        "windows-x86_64": { url: sourceUrl, signature: "signed-installer" },
      },
    };
    const result = publicUpdater(manifest, [asset], "v0.1.4");
    expect(result.platforms["windows-x86_64"]).toEqual({
      url: "https://github.com/jamalavedra/savvy/releases/download/v0.1.4/Savvy_0.1.4_x64-setup.exe",
      signature: "signed-installer",
    });
    expect(publicUpdater(result, [asset], "v0.1.4")).toEqual(result);
  }
});

test("requires an explicit tag and rejects foreign release assets", () => {
  const manifest = {
    platforms: { "darwin-aarch64": { url: "foreign", signature: "signature" } },
  };
  expect(() => publicUpdater(manifest, [])).toThrow("Release tag is required");
  expect(() =>
    publicUpdater(
      manifest,
      [
        {
          url: "foreign",
          browser_download_url: "https://example.com/Savvy.app.tar.gz",
        },
      ],
      "v0.1.4",
    ),
  ).toThrow("unknown release asset");
});
