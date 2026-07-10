import test from "node:test";
import assert from "node:assert/strict";
import { loadTsModule } from "./helpers/loadTsModule.mjs";

let searchPromise = null;

function loadSearchModule() {
  searchPromise ??= loadTsModule(
    "src/lib/ui/panels/breadcrumbTrail/savedTrailsSearch.ts",
  );
  return searchPromise;
}

function entry(url, title = "") {
  return {
    url,
    title,
    favIconUrl: "",
    timestamp: 1000,
    transition: "link",
    redirected: false,
    historyBacked: true,
  };
}

function trail(id, name, entries = [], options = {}) {
  return {
    id,
    name,
    pinned: options.pinned ?? false,
    createdAt: options.createdAt ?? 1000,
    updatedAt: options.updatedAt ?? 1000,
    entries,
  };
}

test("empty search uses pinned, recent, and deterministic identity ordering", async () => {
  const { searchSavedTrails } = await loadSearchModule();
  const trails = [
    trail("z", "Same", [], { updatedAt: 5000 }),
    trail("b", "Same", [], { updatedAt: 5000, pinned: true }),
    trail("a", "Same", [], { updatedAt: 5000, pinned: true }),
    trail("old", "Older", [], { updatedAt: 1000, pinned: true }),
    trail("new", "Newest", [], { updatedAt: 9000 }),
  ];

  const hits = searchSavedTrails(trails, "   ");
  assert.deepEqual(hits.map((hit) => hit.trail.id), ["a", "b", "old", "new", "z"]);
  assert.ok(hits.every((hit) => hit.score === 0 && hit.match === null));
});

test("search ranks exact, contiguous, then tighter subsequences", async () => {
  const { searchSavedTrails } = await loadSearchModule();
  const trails = [
    trail("loose", "dxxoxxcxxs"),
    trail("boundary", "daily online command service"),
    trail("contiguous", "my docs archive"),
    trail("exact", "docs"),
  ];

  const hits = searchSavedTrails(trails, "DoCs");
  assert.deepEqual(hits.map((hit) => hit.trail.id), [
    "exact",
    "contiguous",
    "loose",
    "boundary",
  ]);
  assert.deepEqual(hits[0].match.ranges, [{ start: 0, end: 4 }]);
});

test("a later tighter subsequence outranks the first complete window", async () => {
  const { searchSavedTrails } = await loadSearchModule();
  const hits = searchSavedTrails([
    trail("first-only", "a---b"),
    trail("later-tight", "a----b---a-b"),
  ], "ab");

  assert.deepEqual(hits.map((hit) => hit.trail.id), ["later-tight", "first-only"]);
  assert.deepEqual(hits[0].match.ranges, [
    { start: 9, end: 10 },
    { start: 11, end: 12 },
  ]);
});

test("a wider boundary start cannot outrank a tighter fuzzy window", async () => {
  const { searchSavedTrails } = await loadSearchModule();
  const [hit] = searchSavedTrails([
    trail("tight-policy", "a-aa-aazaaa---b-czcyc-zb-xz"),
  ], "abb");
  assert.deepEqual(hit.match.ranges, [
    { start: 10, end: 11 },
    { start: 14, end: 15 },
    { start: 23, end: 24 },
  ]);
});

test("every query token must match inside one individual field", async () => {
  const { searchSavedTrails } = await loadSearchModule();
  const together = trail("together", "Reference", [
    entry("https://example.test/", "Alpha documentation guide"),
  ]);
  const splitAcrossFields = trail("split-fields", "Alpha", [
    entry("https://example.test/docs", "Documentation"),
  ]);
  const splitAcrossPages = trail("split-pages", "Reference", [
    entry("https://alpha.test/", "Alpha"),
    entry("https://docs.test/", "Documentation"),
  ]);

  const hits = searchSavedTrails(
    [splitAcrossPages, splitAcrossFields, together],
    "apha doc",
  );
  assert.deepEqual(hits.map((hit) => hit.trail.id), ["together"]);
  assert.equal(hits[0].match.field, "title");
  assert.equal(hits[0].match.entryIndex, 0);
});

test("field bonuses break otherwise equal name, title, and URL matches", async () => {
  const { searchSavedTrails } = await loadSearchModule();
  const hits = searchSavedTrails([
    trail("url", "Other", [entry("needle")]),
    trail("title", "Other", [entry("https://example.test/", "needle")]),
    trail("name", "needle", [entry("https://example.test/")]),
  ], "needle");

  assert.deepEqual(hits.map((hit) => hit.trail.id), ["name", "title", "url"]);
  assert.deepEqual(hits.map((hit) => hit.match.field), ["name", "title", "url"]);
});

test("a matching interior page is retained as structured hit metadata", async () => {
  const { searchSavedTrails } = await loadSearchModule();
  const saved = trail("path", "Research path", [
    entry("https://start.test/", "Start"),
    entry("https://example.test/reference", "WebExtension reference"),
    entry("https://end.test/", "Endpoint"),
  ]);

  const [hit] = searchSavedTrails([saved], "wext ref");
  assert.equal(hit.match.field, "title");
  assert.equal(hit.match.entryIndex, 1);
  assert.equal(hit.match.value, "WebExtension reference");
  assert.deepEqual(
    hit.match.ranges.map(({ start, end }) => hit.match.value.slice(start, end)),
    ["W", "Ext", "ref"],
  );
});

test("highlight ranges are valid UTF-16 offsets and never split astral characters", async () => {
  const { searchSavedTrails } = await loadSearchModule();
  const saved = trail("emoji", "A😀lpha");

  const [hit] = searchSavedTrails([saved], "😀a");
  assert.deepEqual(hit.match.ranges, [
    { start: 1, end: 3 },
    { start: 6, end: 7 },
  ]);
  assert.deepEqual(
    hit.match.ranges.map(({ start, end }) => hit.match.value.slice(start, end)),
    ["😀", "a"],
  );
});

test("case folding and canonical normalization are Unicode-consistent", async () => {
  const { searchSavedTrails } = await loadSearchModule();
  const greek = trail("greek", "ΟΣ");
  assert.equal(searchSavedTrails([greek], "ΟΣ").length, 1);
  assert.equal(searchSavedTrails([greek], "ος").length, 1);

  const decomposed = trail("accent", "Cafe\u0301");
  const [accentHit] = searchSavedTrails([decomposed], "CAFÉ");
  assert.ok(accentHit);
  assert.deepEqual(
    accentHit.match.ranges.map(({ start, end }) => accentHit.match.value.slice(start, end)),
    ["Cafe\u0301"],
  );
  assert.equal(searchSavedTrails([trail("composed", "Café")], "cafe\u0301").length, 1);
  assert.equal(searchSavedTrails([trail("unaccented", "Cafe")], "café").length, 1);
});

test("highlight ranges expand to complete grapheme clusters", async () => {
  const { searchSavedTrails } = await loadSearchModule();
  const [accentHit] = searchSavedTrails([trail("accent", "e\u0301")], "e");
  assert.deepEqual(accentHit.match.ranges, [{ start: 0, end: 2 }]);

  const joinedEmoji = "A👩‍💻B";
  const [emojiHit] = searchSavedTrails([trail("joined", joinedEmoji)], "👩");
  assert.equal(
    joinedEmoji.slice(emojiHit.match.ranges[0].start, emojiHit.match.ranges[0].end),
    "👩‍💻",
  );
});

test("long repeated fields stay responsive and oversized queries are bounded", async () => {
  const { MAX_TRAIL_SEARCH_QUERY_LENGTH, searchSavedTrails } = await loadSearchModule();
  const repeated = trail("long", "a".repeat(40_000));
  const startedAt = performance.now();
  assert.deepEqual(searchSavedTrails([repeated], "ab"), []);
  assert.ok(performance.now() - startedAt < 1000, "adversarial search should remain linear");
  assert.deepEqual(
    searchSavedTrails([repeated], "x".repeat(MAX_TRAIL_SEARCH_QUERY_LENGTH + 1)),
    [],
  );
  assert.equal(searchSavedTrails([repeated], "a ".repeat(17)).length, 1);
});

test("long fields produce a grapheme-safe snippet with the tail match visible", async () => {
  const { createTrailSearchSnippet, searchSavedTrails } = await loadSearchModule();
  const name = `${"prefix-".repeat(30)}Cafe\u0301 tail`;
  const [hit] = searchSavedTrails([trail("tail", name)], "café");
  const snippet = createTrailSearchSnippet(name, hit.match.ranges, 24);
  assert.equal(snippet.value.startsWith("…"), true);
  assert.match(snippet.value, /Cafe\u0301/);
  assert.deepEqual(
    snippet.ranges.map(({ start, end }) => snippet.value.slice(start, end)),
    ["Cafe\u0301"],
  );
});

test("relevance outranks pinning, while pinning and recency resolve equal matches", async () => {
  const { searchSavedTrails } = await loadSearchModule();
  const hits = searchSavedTrails([
    trail("loose-pinned", "n---e---e---d", [], { pinned: true, updatedAt: 9000 }),
    trail("exact-old", "need", [], { updatedAt: 1000 }),
    trail("exact-new", "need", [], { updatedAt: 5000 }),
    trail("exact-pinned", "need", [], { pinned: true, updatedAt: 2000 }),
  ], "need");

  assert.deepEqual(hits.map((hit) => hit.trail.id), [
    "exact-pinned",
    "exact-new",
    "exact-old",
    "loose-pinned",
  ]);
});
