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
  const result = publicUpdater(manifest, [asset]);
  expect(result.platforms["darwin-aarch64"]).toEqual({
    url: asset.browser_download_url,
    signature: "signed-archive",
  });
  expect(result.version).toBe(manifest.version);
  expect(manifest.platforms["darwin-aarch64"].url).toBe(asset.url);
  expect(publicUpdater(result, [asset])).toEqual(result);
  expect(() => publicUpdater(manifest, [])).toThrow("unknown release asset");
});
