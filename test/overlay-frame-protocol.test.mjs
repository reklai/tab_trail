import test from "node:test";
import assert from "node:assert/strict";
import { loadTsModule } from "./helpers/loadTsModule.mjs";

let protocolPromise;

function loadProtocol() {
  protocolPromise ??= loadTsModule("src/lib/common/contracts/overlayFrame.ts");
  return protocolPromise;
}

const entry = {
  url: "https://example.test/",
  title: "Example",
  favIconUrl: "https://example.test/favicon.ico",
  timestamp: 1234,
  transition: "link",
  redirected: false,
  historyBacked: true,
};

const trail = {
  id: "trail-1",
  name: "Example trail",
  pinned: false,
  createdAt: 1234,
  updatedAt: 1234,
  entries: [entry],
};

const state = { entries: [entry], cursor: 0 };
const settings = {
  trigger: {
    modifier: "alt",
    withShift: false,
    kind: "key",
    keyCode: "KeyH",
    mouseButton: 1,
  },
  overlayPosition: { xPercent: 50, yPercent: 8 },
  maxVisibleSegments: 8,
};

function fakePort() {
  return {
    postMessage() {},
    start() {},
    close() {},
    addEventListener() {},
    removeEventListener() {},
  };
}

test("connect bootstrap requires the current version, a 128-bit hex nonce, and one port", async () => {
  const protocol = await loadProtocol();
  assert.equal(protocol.OVERLAY_FRAME_PROTOCOL_VERSION, 2);
  const message = {
    type: "TABTRAIL_OVERLAY_CONNECT",
    version: protocol.OVERLAY_FRAME_PROTOCOL_VERSION,
    nonce: "0123456789abcdef0123456789abcdef",
  };
  const port = fakePort();

  assert.equal(protocol.isOverlayFrameConnectMessage(message), true);
  assert.deepEqual(
    protocol.parseOverlayFrameConnectEvent({ data: message, ports: [port] }),
    { message, port },
  );
  assert.equal(
    protocol.isOverlayFrameConnectMessage({ ...message, version: 1 }),
    false,
  );
  assert.equal(
    protocol.isOverlayFrameConnectMessage({ ...message, nonce: "not-a-nonce" }),
    false,
  );
  assert.equal(protocol.parseOverlayFrameConnectEvent({ data: message, ports: [] }), null);
  assert.equal(
    protocol.parseOverlayFrameConnectEvent({ data: message, ports: [port, fakePort()] }),
    null,
  );
  assert.equal(
    protocol.parseOverlayFrameConnectEvent({ data: message, ports: [{}] }),
    null,
  );
});

test("RPC request guard covers every live and SavedTrailsClient operation", async () => {
  const protocol = await loadProtocol();
  const requests = [
    ["LIVE_JUMP", { index: 0 }],
    ["LIVE_OPEN_NEW_TAB", { index: 0 }],
    ["LIVE_OPEN_NEW_WINDOW", { index: 0 }],
    ["LIVE_OPEN_OPTIONS", {}],
    ["LIVE_CLOSE", {}],
    ["LIVE_CLOSE", { mouseButton: 2 }],
    ["LIVE_SET_POSITION", { position: settings.overlayPosition }],
    ["SAVED_LOAD", {}],
    ["SAVED_OPEN", { path: [entry], mode: "new" }],
    ["SAVED_SAVE", { path: [entry], name: "Example" }],
    ["SAVED_RENAME", { id: trail.id, name: "Renamed" }],
    ["SAVED_REPLACE", { id: trail.id, path: [entry], expectedPath: [entry] }],
    ["SAVED_SET_PINNED", { id: trail.id, pinned: true }],
    ["SAVED_DELETE", { id: trail.id }],
    ["SAVED_RESTORE", { trail }],
  ];

  for (const [method, params] of requests) {
    assert.equal(
      protocol.isOverlayRpcRequest({ requestId: 7, method, params }),
      true,
      `${method} should be accepted`,
    );
  }

  assert.equal(
    protocol.isOverlayRpcRequest({ requestId: 7, method: "UNKNOWN", params: {} }),
    false,
  );
  assert.equal(
    protocol.isOverlayRpcRequest({
      requestId: 7,
      method: "SAVED_DUPLICATE",
      params: { id: trail.id },
    }),
    false,
  );
  assert.equal(
    protocol.isOverlayRpcRequest({ requestId: 7, method: "LIVE_JUMP", params: { index: -1 } }),
    false,
  );
  assert.equal(
    protocol.isOverlayRpcRequest({
      requestId: 7,
      method: "LIVE_CLOSE",
      params: { mouseButton: 3 },
    }),
    false,
  );
  assert.equal(
    protocol.isOverlayRpcRequest({
      requestId: 7,
      method: "SAVED_OPEN",
      params: { path: [], mode: "new" },
    }),
    false,
  );
});

test("RPC response guard enforces method-specific result shapes", async () => {
  const protocol = await loadProtocol();
  const mutation = { ok: true, trail, trails: [trail] };
  const replace = { ok: true, trail, previousTrail: trail, trails: [trail] };

  assert.equal(
    protocol.isOverlayRpcResponse({
      requestId: 1,
      method: "SAVED_LOAD",
      result: { ok: true, trails: [trail] },
    }),
    true,
  );
  assert.equal(
    protocol.isOverlayRpcResponse({ requestId: 2, method: "SAVED_SAVE", result: mutation }),
    true,
  );
  assert.equal(
    protocol.isOverlayRpcResponse({ requestId: 3, method: "SAVED_REPLACE", result: replace }),
    true,
  );
  assert.equal(
    protocol.isOverlayRpcResponse({ requestId: 4, method: "LIVE_JUMP", result: { ok: true } }),
    true,
  );
  assert.equal(
    protocol.isOverlayRpcResponse({ requestId: 5, method: "SAVED_REPLACE", result: mutation }),
    false,
  );
  assert.equal(
    protocol.isOverlayRpcResponse({
      requestId: 6,
      method: "SAVED_LOAD",
      result: { ok: true, trails: [{ ...trail, entries: [] }] },
    }),
    false,
  );
});

test("host and frame message guards reject mismatched versions and malformed payloads", async () => {
  const protocol = await loadProtocol();
  const version = protocol.OVERLAY_FRAME_PROTOCOL_VERSION;

  assert.equal(
    protocol.isOverlayHostToFrameMessage({ type: "HOST_INIT", version, settings }),
    true,
  );
  assert.equal(
    protocol.isOverlayHostToFrameMessage({ type: "HOST_INIT", version, state, settings }),
    false,
    "HOST_INIT no longer carries trail state",
  );
  assert.equal(
    protocol.isOverlayHostToFrameMessage({ type: "HOST_HIBERNATE", version }),
    true,
  );
  assert.equal(
    protocol.isOverlayHostToFrameMessage({ type: "HOST_SHOW", version, state, settings }),
    true,
  );
  assert.equal(
    protocol.isOverlayHostToFrameMessage({
      type: "HOST_SAVED_TRAILS_UPDATED",
      version,
      trails: [trail],
    }),
    true,
  );
  assert.equal(
    protocol.isOverlayFrameToHostMessage({
      type: "FRAME_RPC_REQUEST",
      version,
      request: { requestId: 8, method: "LIVE_JUMP", params: { index: 0 } },
    }),
    true,
  );
  assert.equal(
    protocol.isOverlayFrameToHostMessage({
      type: "FRAME_SURFACES_UPDATED",
      version,
      sequence: 4,
      viewportWidth: 1280,
      viewportHeight: 720,
      rects: [{ x: 10, y: 20, width: 30, height: 40 }],
    }),
    true,
  );

  assert.equal(
    protocol.isOverlayHostToFrameMessage({ type: "HOST_INIT", version: 1, settings }),
    false,
  );
  assert.equal(
    protocol.isOverlayHostToFrameMessage({
      type: "HOST_INIT",
      version,
      settings: { ...settings, maxVisibleSegments: 13 },
    }),
    false,
  );
  assert.equal(
    protocol.isOverlayHostToFrameMessage({
      type: "HOST_INIT",
      version,
      settings: { ...settings, trigger: { ...settings.trigger, keyCode: "F1" } },
    }),
    false,
  );
  assert.equal(
    protocol.isOverlayFrameToHostMessage({
      type: "FRAME_SURFACES_UPDATED",
      version,
      sequence: 4,
      viewportWidth: 1280,
      viewportHeight: 720,
      rects: [{ x: 10, y: 20, width: Number.NaN, height: 40 }],
    }),
    false,
  );
  assert.equal(
    protocol.isOverlayFrameToHostMessage({
      type: "FRAME_SURFACES_UPDATED",
      version,
      sequence: 4,
      viewportWidth: 1280,
      viewportHeight: 720,
      rects: Array.from({ length: 33 }, () => ({ x: 1, y: 1, width: 1, height: 1 })),
    }),
    false,
  );
  assert.equal(
    protocol.isOverlayFrameToHostMessage({
      type: "FRAME_SURFACES_UPDATED",
      version,
      sequence: 4,
      viewportWidth: 0,
      viewportHeight: 720,
      rects: [],
    }),
    false,
  );
  assert.equal(
    protocol.isOverlayHostToFrameMessage({ type: "HOST_ESCAPE", version }),
    true,
  );
  assert.equal(
    protocol.isOverlayHostToFrameMessage({ type: "HOST_REQUEST_SURFACES", version }),
    true,
  );
  assert.equal(
    protocol.isOverlayHostToFrameMessage({
      type: "HOST_REQUEST_SURFACES",
      version,
      stale: true,
    }),
    false,
  );
});
