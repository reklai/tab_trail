// Shared pure-ish presentation helpers for trail entry chrome in the overlay.

import { extractDomain } from "../../../common/utils/helpers";

export function entryTitle(entry: TrailEntry): string {
  if (entry.title.trim() !== "") return entry.title.trim();
  const domain = extractDomain(entry.url);
  return domain !== "" ? domain : entry.url;
}

export function entryUrlSubtitle(entry: TrailEntry): string {
  try {
    const parsed = new URL(entry.url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const query = parsed.search ? "?..." : "";
    const hash = parsed.hash ? "#..." : "";
    return `${parsed.hostname}${path}${query}${hash}`;
  } catch (_) {
    return entry.url;
  }
}

export function branchConnectorElement(nextEntry: TrailEntry): HTMLElement {
  const connector = document.createElement("div");
  connector.className = "wf-branch-connector";
  connector.setAttribute("aria-hidden", "true");
  if (!nextEntry.historyBacked) {
    connector.classList.add("wf-branch-connector-inherited");
    connector.title = "Direct-navigation boundary";
  }
  if (nextEntry.transition === "typed") {
    connector.classList.add("wf-branch-connector-typed");
  } else if (nextEntry.transition === "spa" || nextEntry.transition === "fragment") {
    connector.classList.add("wf-branch-connector-spa");
  }
  if (nextEntry.historyBacked) connector.title = nextEntry.transition;
  return connector;
}

export function buildReadOnlyTreeNode(entry: TrailEntry, isEndpoint: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "wf-branch-row wf-trail-tree-node";
  if (isEndpoint) row.classList.add("wf-branch-row-current");

  const node = document.createElement("span");
  node.className = "wf-branch-node";
  node.setAttribute("aria-hidden", "true");
  row.appendChild(node);

  const content = document.createElement("div");
  content.className = "wf-branch-entry";

  const title = document.createElement("span");
  title.className = "wf-branch-entry-title";
  title.textContent = entryTitle(entry);
  content.appendChild(title);

  const url = document.createElement("span");
  url.className = "wf-branch-entry-url";
  url.textContent = entryUrlSubtitle(entry);
  content.appendChild(url);

  row.appendChild(content);
  return row;
}

export function pagesLabel(count: number): string {
  return `${count} page${count === 1 ? "" : "s"}`;
}
