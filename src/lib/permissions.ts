export async function requestPermissionDecision(
  request: () => Promise<unknown>,
  check: () => Promise<boolean>,
) {
  await request();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await check()) return true;
    if (attempt < 19) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
  }
  return false;
}
