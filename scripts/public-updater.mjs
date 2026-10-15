export function publicUpdater(manifest, assets) {
  const result = structuredClone(manifest);
  for (const platform of Object.values(result.platforms)) {
    const asset = assets.find(
      (item) =>
        item.url === platform.url || item.browser_download_url === platform.url,
    );
    if (
      !asset ||
      !asset.browser_download_url?.startsWith(
        "https://github.com/jamalavedra/savvy/releases/download/",
      )
    ) {
      throw new Error("Updater references an unknown release asset");
    }
    platform.url = asset.browser_download_url;
  }
  return result;
}
