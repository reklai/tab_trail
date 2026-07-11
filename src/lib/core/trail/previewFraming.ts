// Pure helpers for deciding whether a trail URL may be embedded in an
// extension-origin iframe preview. Fetch lives in probePreviewFramability;
// header interpretation stays pure for unit tests.

export type PreviewFramable = "yes" | "no" | "unknown";

export interface PreviewFrameAssessment {
  framable: PreviewFramable;
  /** Short machine-oriented reason for tests and logs. */
  code?: "xfo-deny" | "xfo-sameorigin" | "xfo-allow-from" | "csp-none" | "csp-self" | "csp-mismatch";
  /** Plain-language explanation for the fallback card. */
  reason?: string;
}

export interface PreviewProbeResult {
  framable: PreviewFramable;
  reason?: string;
  code?: PreviewFrameAssessment["code"];
}

const BLOCKED_EMBED_COPY =
  "This site blocks embedding, so a live preview isn’t available.";

function splitHeaderList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function normalizeXfoToken(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Collect every `frame-ancestors` source list from a CSP header value.
 * Multiple policies (comma-joined by Header.get) are separate lists; CSP
 * requires all policies to allow framing, so callers AND the assessments.
 */
export function extractFrameAncestorsDirectives(
  contentSecurityPolicy: string | null | undefined,
): string[][] {
  if (typeof contentSecurityPolicy !== "string" || contentSecurityPolicy.trim() === "") {
    return [];
  }
  const directives: string[][] = [];
  const pattern = /(?:^|[,;])\s*frame-ancestors\s+([^;]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(contentSecurityPolicy)) !== null) {
    const sources = match[1]
      .trim()
      .split(/\s+/)
      .map((source) => source.trim())
      .filter((source) => source !== "");
    directives.push(sources);
  }
  return directives;
}

/**
 * Evaluate X-Frame-Options and CSP frame-ancestors for an extension-origin
 * embedder. Missing both policies means the browser default (allow).
 */
export function assessPreviewFraming(
  xFrameOptions: string | null | undefined,
  contentSecurityPolicy: string | null | undefined,
  embedderOrigin: string,
): PreviewFrameAssessment {
  const xfo = typeof xFrameOptions === "string" ? xFrameOptions.trim() : "";
  if (xfo !== "") {
    // Multiple XFO values: any restrictive token blocks (conservative for honesty).
    for (const raw of splitHeaderList(xfo)) {
      const token = normalizeXfoToken(raw);
      if (token === "DENY") {
        return { framable: "no", code: "xfo-deny", reason: BLOCKED_EMBED_COPY };
      }
      if (token === "SAMEORIGIN") {
        return { framable: "no", code: "xfo-sameorigin", reason: BLOCKED_EMBED_COPY };
      }
      if (token.startsWith("ALLOW-FROM")) {
        // Legacy; almost never allows an extension origin. Treat as blocked.
        return { framable: "no", code: "xfo-allow-from", reason: BLOCKED_EMBED_COPY };
      }
    }
  }

  const directives = extractFrameAncestorsDirectives(contentSecurityPolicy);
  if (directives.length === 0) {
    return { framable: "yes" };
  }

  // Multiple CSP policies AND together: any denial wins.
  let sawUnknown = false;
  for (const sources of directives) {
    const result = assessFrameAncestors(sources, embedderOrigin);
    if (result.framable === "no") return result;
    if (result.framable === "unknown") sawUnknown = true;
  }
  return sawUnknown ? { framable: "unknown" } : { framable: "yes" };
}

function assessFrameAncestors(
  sources: readonly string[],
  embedderOrigin: string,
): PreviewFrameAssessment {
  if (sources.length === 0) {
    return { framable: "no", code: "csp-none", reason: BLOCKED_EMBED_COPY };
  }
  const lowered = sources.map((source) => source.toLowerCase());
  if (lowered.includes("'none'")) {
    return { framable: "no", code: "csp-none", reason: BLOCKED_EMBED_COPY };
  }
  if (lowered.includes("*")) {
    return { framable: "yes" };
  }

  let embedder: URL;
  try {
    embedder = new URL(embedderOrigin);
  } catch (_) {
    return { framable: "unknown" };
  }

  for (const source of sources) {
    if (sourceMatchesEmbedder(source, embedder)) {
      return { framable: "yes" };
    }
  }

  if (lowered.every((source) => source === "'self'" || source === "self")) {
    return { framable: "no", code: "csp-self", reason: BLOCKED_EMBED_COPY };
  }
  return { framable: "no", code: "csp-mismatch", reason: BLOCKED_EMBED_COPY };
}

function sourceMatchesEmbedder(source: string, embedder: URL): boolean {
  const trimmed = source.trim();
  if (trimmed === "" || trimmed === "'none'" || trimmed === "'self'") return false;
  if (trimmed === "*") return true;
  // scheme-source e.g. https:
  if (/^[a-z][a-z0-9+.-]*:$/i.test(trimmed)) {
    return embedder.protocol.toLowerCase() === trimmed.toLowerCase();
  }
  try {
    const candidate = trimmed.includes("://")
      ? new URL(trimmed)
      : new URL(`${embedder.protocol}//${trimmed.replace(/^\/\//, "")}`);
    if (candidate.protocol && candidate.protocol !== embedder.protocol) return false;
    return hostSourceMatches(candidate.hostname, embedder.hostname) &&
      (candidate.port === "" || candidate.port === embedder.port);
  } catch (_) {
    return false;
  }
}

function hostSourceMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === "*") return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) || h === p.slice(2);
  }
  return p === h;
}

export function readFramingHeaders(headers: Headers): {
  xFrameOptions: string | null;
  contentSecurityPolicy: string | null;
} {
  return {
    xFrameOptions: headers.get("x-frame-options"),
    contentSecurityPolicy: headers.get("content-security-policy"),
  };
}

const PROBE_TIMEOUT_MS = 4000;

/** Drop the body stream once headers are enough — GET fallback is headers-only. */
function discardResponseBody(response: Response): void {
  try {
    void response.body?.cancel();
  } catch (_) {
    // Ignore cancel failures; probe still has headers.
  }
}

function assessFromResponse(
  response: Response,
  embedderOrigin: string,
): PreviewProbeResult {
  const { xFrameOptions, contentSecurityPolicy } = readFramingHeaders(response.headers);
  discardResponseBody(response);
  return assessPreviewFraming(xFrameOptions, contentSecurityPolicy, embedderOrigin);
}

function hasFramingHeaders(response: Response): boolean {
  const { xFrameOptions, contentSecurityPolicy } = readFramingHeaders(response.headers);
  return Boolean(xFrameOptions || contentSecurityPolicy);
}

/**
 * Best-effort network probe. Failures yield `unknown` so the caller can still
 * attempt an iframe load with a timeout rather than false-blocking.
 * Prefer HEAD; only GET when headers are still needed, then cancel the body.
 */
export async function probePreviewFramability(
  url: string,
  embedderOrigin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PreviewProbeResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (_) {
    return {
      framable: "no",
      reason: "This address isn’t a valid page URL, so it can’t be previewed.",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      framable: "no",
      reason: "Only http(s) pages can be previewed here.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    let response: Response | null = null;
    try {
      response = await fetchImpl(parsed.href, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
      });
    } catch (_) {
      response = null;
    }

    if (response && response.status < 400) {
      return assessFromResponse(response, embedderOrigin);
    }

    // Error responses often still carry XFO/CSP. Prefer those over a full GET
    // body download when framing headers are already present (e.g. 403/404).
    if (response && hasFramingHeaders(response)) {
      return assessFromResponse(response, embedderOrigin);
    }
    if (response) discardResponseBody(response);

    // Hosts that reject HEAD (405/501/network) or return 4xx without framing
    // headers: one GET for headers only, then cancel the body stream.
    try {
      response = await fetchImpl(parsed.href, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
      });
    } catch (_) {
      return { framable: "unknown" };
    }
    if (!response) return { framable: "unknown" };
    return assessFromResponse(response, embedderOrigin);
  } catch (_) {
    return { framable: "unknown" };
  } finally {
    clearTimeout(timer);
  }
}
