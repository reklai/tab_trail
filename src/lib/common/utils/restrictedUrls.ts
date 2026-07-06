// Browser store / privileged pages where extensions cannot run content scripts.
// Shared by the background (skips content-script injection) and the popup
// (explains the shortcut is unavailable) so the two never disagree on which
// URLs are blocked.

const BROWSER_STORE_RESTRICTED_HOSTS = new Set([
  "addons.mozilla.org",
  "chromewebstore.google.com",
  "microsoftedge.microsoft.com",
]);

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

export function isKnownBrowserStoreRestrictedUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const hostname = normalizeHostname(parsed.hostname);
    if (BROWSER_STORE_RESTRICTED_HOSTS.has(hostname)) return true;
    return hostname === "chrome.google.com" && parsed.pathname.toLowerCase().startsWith("/webstore");
  } catch (_) {
    return false;
  }
}
