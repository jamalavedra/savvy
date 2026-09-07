export const CONSENT_KEY = "savvy.analytics-consent";
export const CONSENT_YEAR = 365 * 24 * 60 * 60 * 1000;

export function readConsent(
  raw: string | null,
  now = Date.now(),
): { allowed: boolean; expires: number } | null {
  try {
    const value = JSON.parse(raw || "null");
    return typeof value?.allowed === "boolean" &&
      Number.isFinite(value.expires) &&
      value.expires > now &&
      value.expires <= now + CONSENT_YEAR
      ? { allowed: value.allowed, expires: value.expires }
      : null;
  } catch {
    return null;
  }
}
