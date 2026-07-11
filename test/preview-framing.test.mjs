import test from "node:test";
import assert from "node:assert/strict";
import { loadTsModule } from "./helpers/loadTsModule.mjs";

const EMBEDDER = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

let framingPromise;

function loadFraming() {
  framingPromise ??= loadTsModule("src/lib/core/trail/previewFraming.ts");
  return framingPromise;
}

test("missing framing headers allow embedding by default", async () => {
  const mod = await loadFraming();
  assert.deepEqual(mod.assessPreviewFraming(null, null, EMBEDDER), { framable: "yes" });
  assert.deepEqual(mod.assessPreviewFraming("", "", EMBEDDER), { framable: "yes" });
});

test("X-Frame-Options DENY and SAMEORIGIN block extension embeds", async () => {
  const mod = await loadFraming();
  assert.equal(mod.assessPreviewFraming("DENY", null, EMBEDDER).framable, "no");
  assert.equal(mod.assessPreviewFraming("deny", null, EMBEDDER).code, "xfo-deny");
  assert.equal(mod.assessPreviewFraming("SAMEORIGIN", null, EMBEDDER).framable, "no");
  assert.equal(mod.assessPreviewFraming("sameorigin", null, EMBEDDER).code, "xfo-sameorigin");
  assert.match(
    mod.assessPreviewFraming("DENY", null, EMBEDDER).reason,
    /blocks embedding/i,
  );
});

test("CSP frame-ancestors 'none' and 'self' block extension embeds", async () => {
  const mod = await loadFraming();
  const none = mod.assessPreviewFraming(null, "frame-ancestors 'none'", EMBEDDER);
  assert.equal(none.framable, "no");
  assert.equal(none.code, "csp-none");

  const self = mod.assessPreviewFraming(
    null,
    "default-src 'self'; frame-ancestors 'self'",
    EMBEDDER,
  );
  assert.equal(self.framable, "no");
  assert.equal(self.code, "csp-self");
});

test("CSP frame-ancestors * allows embedding", async () => {
  const mod = await loadFraming();
  assert.equal(
    mod.assessPreviewFraming(null, "frame-ancestors *", EMBEDDER).framable,
    "yes",
  );
});

test("CSP frame-ancestors listing the extension origin allows it", async () => {
  const mod = await loadFraming();
  const csp = `frame-ancestors ${EMBEDDER}`;
  assert.equal(mod.assessPreviewFraming(null, csp, EMBEDDER).framable, "yes");
});

test("multiple CSP policies AND together so any denial wins", async () => {
  const mod = await loadFraming();
  // Header.get joins multiple CSP headers with ", "
  const joined = "frame-ancestors *, frame-ancestors 'none'";
  const result = mod.assessPreviewFraming(null, joined, EMBEDDER);
  assert.equal(result.framable, "no");
});

test("probe rejects non-http(s) without fetching", async () => {
  const mod = await loadFraming();
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    throw new Error("should not fetch");
  };
  const result = await mod.probePreviewFramability(
    "about:blank",
    EMBEDDER,
    fetchImpl,
  );
  assert.equal(result.framable, "no");
  assert.equal(called, 0);
  assert.match(result.reason, /http/i);
});

test("probe maps response headers through assessPreviewFraming", async () => {
  const mod = await loadFraming();
  const headers = new Headers({ "x-frame-options": "DENY" });
  const fetchImpl = async () =>
    new Response(null, { status: 200, headers });
  const result = await mod.probePreviewFramability(
    "https://blocked.example/",
    EMBEDDER,
    fetchImpl,
  );
  assert.equal(result.framable, "no");
  assert.equal(result.code, "xfo-deny");
});

test("probe returns unknown when fetch fails", async () => {
  const mod = await loadFraming();
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  const result = await mod.probePreviewFramability(
    "https://flaky.example/",
    EMBEDDER,
    fetchImpl,
  );
  assert.equal(result.framable, "unknown");
});

test("probe falls back from failed HEAD to GET", async () => {
  const mod = await loadFraming();
  const methods = [];
  const fetchImpl = async (url, init = {}) => {
    methods.push(init.method);
    if (init.method === "HEAD") {
      return new Response(null, { status: 405 });
    }
    return new Response(null, {
      status: 200,
      headers: { "content-security-policy": "frame-ancestors *" },
    });
  };
  const result = await mod.probePreviewFramability(
    "https://headless.example/",
    EMBEDDER,
    fetchImpl,
  );
  assert.deepEqual(methods, ["HEAD", "GET"]);
  assert.equal(result.framable, "yes");
});

test("probe uses 4xx HEAD framing headers without GET", async () => {
  const mod = await loadFraming();
  const methods = [];
  const fetchImpl = async (_url, init = {}) => {
    methods.push(init.method);
    return new Response(null, {
      status: 403,
      headers: { "x-frame-options": "DENY" },
    });
  };
  const result = await mod.probePreviewFramability(
    "https://forbidden.example/",
    EMBEDDER,
    fetchImpl,
  );
  assert.deepEqual(methods, ["HEAD"]);
  assert.equal(result.framable, "no");
  assert.equal(result.code, "xfo-deny");
});

test("probe cancels GET response body after reading headers", async () => {
  const mod = await loadFraming();
  let cancelCount = 0;
  const fetchImpl = async (_url, init = {}) => {
    if (init.method === "HEAD") {
      return new Response(null, { status: 405 });
    }
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("huge body"));
      },
      cancel() {
        cancelCount += 1;
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "x-frame-options": "SAMEORIGIN" },
    });
  };
  const result = await mod.probePreviewFramability(
    "https://big.example/",
    EMBEDDER,
    fetchImpl,
  );
  assert.equal(result.framable, "no");
  assert.equal(cancelCount, 1);
});
