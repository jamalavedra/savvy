export function publicUpdater(manifest, assets, tag) {
  if (!tag) throw new Error("Release tag is required");
  const prefix = "https://github.com/jamalavedra/savvy/releases/download/";
  const downloadUrl = (asset) => {
    const url = asset.browser_download_url;
    if (!url?.startsWith(prefix)) return undefined;
    return `${prefix}${encodeURIComponent(tag)}/${url.slice(url.lastIndexOf("/") + 1)}`;
  };
  const result = structuredClone(manifest);
  for (const platform of Object.values(result.platforms)) {
    const asset = assets.find(
      (item) =>
        item.url === platform.url ||
        item.browser_download_url === platform.url ||
        downloadUrl(item) === platform.url,
    );
    const url = asset && downloadUrl(asset);
    if (!url) {
      throw new Error("Updater references an unknown release asset");
    }
    platform.url = url;
  }
  return result;
}
