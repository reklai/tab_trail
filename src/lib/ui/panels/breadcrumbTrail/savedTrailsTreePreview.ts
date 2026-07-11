// Read-only path-tree preview for a saved trail.

import { clampInViewport } from "./freePixelDrag";
import {
  closeOverlaySurface,
  pushOverlaySurface,
} from "./overlaySurfaces";
import {
  branchConnectorElement,
  buildReadOnlyTreeNode,
  pagesLabel,
} from "./trailPresentation";
import {
  LIBRARY_PANEL_GAP,
  VIEWPORT_MARGIN,
  restoreSurfaceFocus,
  savedTrailsUi,
} from "./savedTrailsSession";

export function openSavedTrailTreePreview(trail: SavedTrail, opener: HTMLElement | null): void {
  if (!savedTrailsUi.host) return;
  const previewHost = savedTrailsUi.host;
  previewHost.closeLiveSurfaces();
  closeOverlaySurface("menu");
  closeOverlaySurface("treePreview");

  const panel = document.createElement("div");
  panel.className = "wf-trail-tree-preview";
  panel.dataset.tabtrailHitSurface = "";
  panel.dataset.tabtrailWheelSurface = "";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", `Preview path: ${trail.name}`);

  const header = document.createElement("div");
  header.className = "wf-trail-tree-preview-header";
  const identity = document.createElement("div");
  identity.className = "wf-trail-tree-preview-identity";
  const kicker = document.createElement("div");
  kicker.className = "wf-trail-tree-preview-kicker";
  kicker.textContent = "Preview";
  identity.appendChild(kicker);
  const title = document.createElement("div");
  title.className = "wf-trail-tree-preview-title";
  title.textContent = trail.name;
  identity.appendChild(title);
  const meta = document.createElement("div");
  meta.className = "wf-trail-tree-preview-meta";
  const hasDirectNavigation = trail.entries.some(
    (entry, index) => index > 0 && !entry.historyBacked,
  );
  meta.textContent = `${pagesLabel(trail.entries.length)}${
    hasDirectNavigation ? " · Contains direct-navigation steps" : ""
  }`;
  identity.appendChild(meta);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "wf-trail-tree-preview-close";
  close.textContent = "✕";
  close.title = "Close preview";
  close.setAttribute("aria-label", "Close path preview");
  close.addEventListener("click", () => closeOverlaySurface("treePreview"));
  header.appendChild(identity);
  header.appendChild(close);
  panel.appendChild(header);

  const list = document.createElement("div");
  list.className = "wf-trail-tree-preview-list";
  list.dataset.tabtrailScrollRegion = "";
  for (let index = 0; index < trail.entries.length; index += 1) {
    const entry = trail.entries[index];
    if (index > 0) list.appendChild(branchConnectorElement(entry));
    list.appendChild(buildReadOnlyTreeNode(entry, index === trail.entries.length - 1));
  }
  panel.appendChild(list);
  previewHost.layer.appendChild(panel);
  savedTrailsUi.setTreePreviewElement(panel);
  positionTreePreview(panel);

  pushOverlaySurface("treePreview", () => {
    panel.remove();
    savedTrailsUi.setTreePreviewElement(null);
    if (savedTrailsUi.host === previewHost) restoreSurfaceFocus(previewHost, opener);
  });
  close.focus({ preventScroll: true });
}

export function positionTreePreview(panel: HTMLElement): void {
  if (!savedTrailsUi.host) return;
  const margin = VIEWPORT_MARGIN;
  const width = Math.min(360, Math.max(260, savedTrailsUi.host.bar.getBoundingClientRect().width));
  panel.style.width = `${width}px`;
  const anchor = savedTrailsUi.librarySession?.panel ?? savedTrailsUi.host.bar;
  const anchorRect = anchor.getBoundingClientRect();
  const rightSpace = window.innerWidth - anchorRect.right - LIBRARY_PANEL_GAP - margin;
  const leftSpace = anchorRect.left - LIBRARY_PANEL_GAP - margin;
  let left: number;
  if (rightSpace >= width) left = anchorRect.right + LIBRARY_PANEL_GAP;
  else if (leftSpace >= width) left = anchorRect.left - LIBRARY_PANEL_GAP - width;
  else left = Math.min(Math.max(margin, anchorRect.left), Math.max(margin, window.innerWidth - width - margin));
  const maxHeight = Math.max(160, window.innerHeight - margin * 2);
  panel.style.maxHeight = `${Math.min(maxHeight, 420)}px`;
  const height = Math.min(panel.getBoundingClientRect().height || 280, maxHeight);
  const top = Math.min(
    Math.max(margin, anchorRect.top),
    Math.max(margin, window.innerHeight - height - margin),
  );
  const clamped = clampInViewport(left, top, width, height || 200, margin);
  panel.style.left = `${clamped.left}px`;
  panel.style.top = `${clamped.top}px`;
}
