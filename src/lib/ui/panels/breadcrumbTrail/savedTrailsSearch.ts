// Pure saved-trail search and ranking. Query tokens must all match within one
// field (the trail name, one page title, or one page URL), so matches never
// become surprising by spanning unrelated pages or fields.

export interface TrailSearchRange {
  /** UTF-16 offset into `TrailSearchFieldHit.value`, inclusive. */
  start: number;
  /** UTF-16 offset into `TrailSearchFieldHit.value`, exclusive. */
  end: number;
}

export type TrailSearchField = "name" | "title" | "url";

export interface TrailSearchFieldHit {
  field: TrailSearchField;
  /** Null for the saved-trail name; otherwise the matching page's path index. */
  entryIndex: number | null;
  value: string;
  ranges: TrailSearchRange[];
  score: number;
}

export interface TrailSearchHit {
  trail: SavedTrail;
  /** Search relevance only. Pinned/recent ordering is applied as a tie-break. */
  score: number;
  /** Null only when the query is empty. */
  match: TrailSearchFieldHit | null;
}

export interface TrailSearchSnippet {
  value: string;
  ranges: TrailSearchRange[];
}

export const MAX_TRAIL_SEARCH_QUERY_LENGTH = 160;

interface SourceCluster {
  value: string;
  start: number;
  end: number;
}

interface FoldedUnit {
  char: string;
  start: number;
  end: number;
  boundary: boolean;
}

interface TokenMatch {
  positions: number[];
  score: number;
  span: number;
}

interface RankedHit extends TrailSearchHit {
  sourceIndex: number;
}

const FIELD_BONUS: Readonly<Record<TrailSearchField, number>> = {
  name: 30,
  title: 20,
  url: 10,
};
const TOKEN_GAP_PENALTY = 100_000;

const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function isWordCharacter(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function isLowercaseLetter(value: string): boolean {
  return /\p{Ll}/u.test(value);
}

function isUppercaseLetter(value: string): boolean {
  return /\p{Lu}/u.test(value);
}

function isGraphemeContinuation(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return /\p{M}/u.test(value) || value === "\u200d" ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff);
}

function sourceClusters(value: string): SourceCluster[] {
  if (graphemeSegmenter) {
    return [...graphemeSegmenter.segment(value)].map((part) => ({
      value: part.segment,
      start: part.index,
      end: part.index + part.segment.length,
    }));
  }

  // Older engines fall back to code points while keeping combining marks,
  // variation selectors, emoji modifiers, and ZWJ sequences together.
  const clusters: SourceCluster[] = [];
  let current = "";
  let start = 0;
  let offset = 0;
  for (const character of value) {
    const continues = current !== "" &&
      (isGraphemeContinuation(character) || current.endsWith("\u200d"));
    if (!continues && current !== "") {
      clusters.push({ value: current, start, end: offset });
      current = "";
      start = offset;
    }
    current += character;
    offset += character.length;
  }
  if (current !== "") clusters.push({ value: current, start, end: offset });
  return clusters;
}

function foldCluster(value: string): string[] {
  // NFKD makes canonically equivalent accents and compatibility characters
  // comparable. Upper-then-lower approximates Unicode case folding for forms
  // such as final sigma and sharp-s; marks are ignored for accent-insensitive
  // search while their complete source grapheme remains highlightable.
  const folded = value.normalize("NFKD").toUpperCase().toLowerCase().normalize("NFKD");
  return [...folded].filter((character) => !/\p{M}/u.test(character));
}

/**
 * Case-fold a string while retaining offsets into the original UTF-16 text.
 * Iterating by code point ensures a returned range can never bisect a
 * surrogate pair. A case fold that expands a code point maps every expansion
 * unit back to the complete original code point.
 */
function foldWithOffsets(value: string): FoldedUnit[] {
  const units: FoldedUnit[] = [];
  let previous = "";
  for (const cluster of sourceClusters(value)) {
    const boundary = cluster.start === 0 || !isWordCharacter(previous) ||
      (isLowercaseLetter(previous) && isUppercaseLetter(cluster.value));
    const folded = foldCluster(cluster.value);
    let firstExpansionUnit = true;
    for (const foldedCharacter of folded) {
      units.push({
        char: foldedCharacter,
        start: cluster.start,
        end: cluster.end,
        boundary: boundary && firstExpansionUnit,
      });
      firstExpansionUnit = false;
    }
    previous = cluster.value;
  }
  return units;
}

function foldQueryToken(token: string): string[] {
  return foldWithOffsets(token).map((unit) => unit.char);
}

function queryTokens(query: string): string[][] | null {
  const trimmed = query.trim();
  if (trimmed.length > MAX_TRAIL_SEARCH_QUERY_LENGTH) return null;
  const rawTokens = trimmed.split(/\s+/u).filter(Boolean);
  const tokens = rawTokens.map(foldQueryToken);
  if (tokens.some((token) => token.length === 0)) return null;
  const seen = new Set<string>();
  return tokens.filter((token) => {
    const key = JSON.stringify(token);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreTokenPositions(
  units: readonly FoldedUnit[],
  positions: number[],
): TokenMatch {
  const span = positions[positions.length - 1] - positions[0] + 1;
  const gaps = span - positions.length;
  const startsAtBoundary = units[positions[0]].boundary;
  const exact = units.length === positions.length && positions[0] === 0 && gaps === 0;
  const contiguous = gaps === 0;
  const score = 101_000 - gaps * TOKEN_GAP_PENALTY +
    (exact ? 1200 : 0) +
    (contiguous ? 240 : 0) +
    (startsAtBoundary ? 40 : 0);
  return { positions, score, span };
}

function tokenPrefixTable(token: readonly string[]): number[] {
  const prefix = new Array<number>(token.length).fill(0);
  for (let index = 1, matched = 0; index < token.length; index += 1) {
    while (matched > 0 && token[index] !== token[matched]) matched = prefix[matched - 1];
    if (token[index] === token[matched]) matched += 1;
    prefix[index] = matched;
  }
  return prefix;
}

/** Find the strongest deterministic subsequence for one token in linear time. */
function matchToken(units: readonly FoldedUnit[], token: readonly string[]): TokenMatch | null {
  if (token.length === 0 || units.length === 0) return null;

  // Prefer a contiguous occurrence. KMP keeps repeated-character inputs
  // linear instead of rescanning the remaining field for every possible start.
  const prefix = tokenPrefixTable(token);
  let matched = 0;
  let bestContiguousStart = -1;
  let bestContiguousScore = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < units.length; index += 1) {
    while (matched > 0 && units[index].char !== token[matched]) matched = prefix[matched - 1];
    if (units[index].char === token[matched]) matched += 1;
    if (matched !== token.length) continue;
    const start = index - token.length + 1;
    const exact = units.length === token.length && start === 0;
    const score = 101_000 + (exact ? 1200 : 0) + 240 +
      (units[start].boundary ? 40 : 0);
    if (score > bestContiguousScore) {
      bestContiguousStart = start;
      bestContiguousScore = score;
    }
    matched = prefix[matched - 1];
  }
  if (bestContiguousStart >= 0) {
    const positions = Array.from(
      { length: token.length },
      (_, index) => bestContiguousStart + index,
    );
    return { positions, score: bestContiguousScore, span: token.length };
  }

  // With no contiguous occurrence, enumerate minimal subsequence windows: a
  // forward pass finds an end, a backward pass tightens its start, and the
  // next pass begins just after that start. Query length is explicitly bounded,
  // so this stays linear in field length with a small fixed upper factor while
  // still finding a later, tighter window than the first complete one.
  let best: TokenMatch | null = null;
  let searchStart = 0;
  while (searchStart < units.length) {
    let tokenIndex = 0;
    let matchEnd = -1;
    for (let index = searchStart; index < units.length; index += 1) {
      if (units[index].char !== token[tokenIndex]) continue;
      tokenIndex += 1;
      if (tokenIndex === token.length) {
        matchEnd = index;
        break;
      }
    }
    if (matchEnd < 0) break;

    const tightened = new Array<number>(token.length);
    tokenIndex = token.length - 1;
    for (let index = matchEnd; index >= searchStart && tokenIndex >= 0; index -= 1) {
      if (units[index].char !== token[tokenIndex]) continue;
      tightened[tokenIndex] = index;
      tokenIndex -= 1;
    }
    const candidate = scoreTokenPositions(units, tightened);
    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.span < best.span) ||
      (candidate.score === best.score && candidate.span === best.span &&
        candidate.positions[0] < best.positions[0])
    ) best = candidate;
    searchStart = tightened[0] + 1;
  }

  return best;
}

function rangesForPositions(
  units: readonly FoldedUnit[],
  positions: readonly number[],
): TrailSearchRange[] {
  const sourceRanges = positions.map((position) => ({
    start: units[position].start,
    end: units[position].end,
  })).sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TrailSearchRange[] = [];
  for (const range of sourceRanges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function matchField(
  field: TrailSearchField,
  value: string,
  entryIndex: number | null,
  tokens: readonly string[][],
): TrailSearchFieldHit | null {
  if (value === "") return null;
  const units = foldWithOffsets(value);
  const tokenMatches: TokenMatch[] = [];
  for (const token of tokens) {
    const match = matchToken(units, token);
    if (!match) return null;
    tokenMatches.push(match);
  }

  const allPositions = tokenMatches.flatMap((match) => match.positions);
  const foldedValue = units.map((unit) => unit.char).join("");
  const foldedQuery = tokens.map((token) => token.join("")).join(" ");
  const exactQuery = foldedValue === foldedQuery;
  const contiguousQuery = !exactQuery && foldedQuery !== "" && foldedValue.includes(foldedQuery);
  const score = tokenMatches.reduce((total, match) => total + match.score, 0) +
    (exactQuery ? 1600 : 0) +
    (contiguousQuery ? 500 : 0) +
    FIELD_BONUS[field];
  return {
    field,
    entryIndex,
    value,
    ranges: rangesForPositions(units, allPositions),
    score,
  };
}

function fieldOrder(field: TrailSearchField): number {
  if (field === "name") return 0;
  if (field === "title") return 1;
  return 2;
}

function compareFieldHits(left: TrailSearchFieldHit, right: TrailSearchFieldHit): number {
  const leftEntry = left.entryIndex ?? -1;
  const rightEntry = right.entryIndex ?? -1;
  return right.score - left.score || fieldOrder(left.field) - fieldOrder(right.field) ||
    rightEntry - leftEntry || left.ranges[0].start - right.ranges[0].start;
}

function bestTrailMatch(
  trail: SavedTrail,
  tokens: readonly string[][],
): TrailSearchFieldHit | null {
  const candidates: TrailSearchFieldHit[] = [];
  const nameMatch = matchField("name", trail.name, null, tokens);
  if (nameMatch) candidates.push(nameMatch);
  for (let entryIndex = 0; entryIndex < trail.entries.length; entryIndex += 1) {
    const entry = trail.entries[entryIndex];
    const titleMatch = matchField("title", entry.title, entryIndex, tokens);
    if (titleMatch) candidates.push(titleMatch);
    const urlMatch = matchField("url", entry.url, entryIndex, tokens);
    if (urlMatch) candidates.push(urlMatch);
  }
  candidates.sort(compareFieldHits);
  return candidates[0] ?? null;
}

function compareText(left: string, right: string): number {
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareTrailTies(left: RankedHit, right: RankedHit): number {
  if (left.trail.pinned !== right.trail.pinned) return left.trail.pinned ? -1 : 1;
  return right.trail.updatedAt - left.trail.updatedAt ||
    right.trail.createdAt - left.trail.createdAt ||
    compareText(left.trail.name, right.trail.name) ||
    compareText(left.trail.id, right.trail.id) ||
    left.sourceIndex - right.sourceIndex;
}

/**
 * Crop a long matching field around its highlighted graphemes. This keeps a
 * match near the tail visible inside the library's single-line ellipsis rows.
 */
export function createTrailSearchSnippet(
  value: string,
  ranges: readonly TrailSearchRange[],
  maxLength = 64,
): TrailSearchSnippet {
  const clusters = sourceClusters(value);
  const safeMaximum = Math.max(8, Math.floor(maxLength));
  if (ranges.length === 0 || clusters.length <= safeMaximum) {
    return { value, ranges: ranges.map((range) => ({ ...range })) };
  }

  const sortedRanges = [...ranges].sort((left, right) => left.start - right.start);
  const firstMatch = clusters.findIndex((cluster) => cluster.end > sortedRanges[0].start);
  let lastMatch = -1;
  for (let index = clusters.length - 1; index >= 0; index -= 1) {
    if (clusters[index].start < sortedRanges[sortedRanges.length - 1].end) {
      lastMatch = index;
      break;
    }
  }
  if (firstMatch < 0 || lastMatch < firstMatch) {
    return { value, ranges: sortedRanges.map((range) => ({ ...range })) };
  }

  const matchSpan = lastMatch - firstMatch + 1;
  const leadingContext = Math.min(8, Math.floor(safeMaximum / 4));
  let start = Math.max(0, firstMatch - leadingContext);
  if (matchSpan <= safeMaximum) start = Math.max(start, lastMatch - safeMaximum + 1);
  const end = Math.min(clusters.length, start + safeMaximum);
  const sourceStart = clusters[start].start;
  const sourceEnd = clusters[end - 1].end;
  const hasPrefix = sourceStart > 0;
  const hasSuffix = sourceEnd < value.length;
  const prefix = hasPrefix ? "…" : "";
  const suffix = hasSuffix ? "…" : "";
  const offset = prefix.length - sourceStart;
  const adjustedRanges = sortedRanges
    .filter((range) => range.end > sourceStart && range.start < sourceEnd)
    .map((range) => ({
      start: Math.max(sourceStart, range.start) + offset,
      end: Math.min(sourceEnd, range.end) + offset,
    }));

  return {
    value: `${prefix}${value.slice(sourceStart, sourceEnd)}${suffix}`,
    ranges: adjustedRanges,
  };
}

/**
 * Fuzzy-search saved trails and return renderer-ready match metadata.
 *
 * Non-empty queries rank exact/contiguous and tighter matches first. A word
 * boundary breaks equal-width matches, followed by the small name/title/URL
 * field bonus, pinning, and recency. An empty query skips matching and returns
 * the same pinned/recent deterministic baseline order.
 */
export function searchSavedTrails(
  trails: readonly SavedTrail[],
  query: string,
): TrailSearchHit[] {
  const tokens = queryTokens(query);
  if (tokens === null) return [];
  const hits: RankedHit[] = [];
  for (let sourceIndex = 0; sourceIndex < trails.length; sourceIndex += 1) {
    const trail = trails[sourceIndex];
    if (tokens.length === 0) {
      hits.push({ trail, score: 0, match: null, sourceIndex });
      continue;
    }
    const match = bestTrailMatch(trail, tokens);
    if (match) hits.push({ trail, score: match.score, match, sourceIndex });
  }
  hits.sort((left, right) => {
    if (tokens.length > 0 && left.score !== right.score) return right.score - left.score;
    return compareTrailTies(left, right);
  });
  return hits.map(({ trail, score, match }) => ({ trail, score, match }));
}
