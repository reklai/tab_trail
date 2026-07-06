// Shared utility functions used across content script modules.

/** Extract hostname from a URL, with fallback to truncated string */
const DOMAIN_CACHE_MAX = 500;
const domainCache = new Map<string, string>();

function cacheDomain(url: string, value: string): string {
  if (domainCache.size >= DOMAIN_CACHE_MAX) {
    const firstKey = domainCache.keys().next().value;
    if (firstKey !== undefined) domainCache.delete(firstKey);
  }
  domainCache.set(url, value);
  return value;
}

export function extractDomain(url: string): string {
  const cached = domainCache.get(url);
  if (cached) return cached;
  try {
    return cacheDomain(url, new URL(url).hostname);
  } catch (_) {
    return cacheDomain(url, url.length > 30 ? url.substring(0, 30) + "\u2026" : url);
  }
}
