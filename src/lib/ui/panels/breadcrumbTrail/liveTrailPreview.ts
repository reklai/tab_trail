// Draggable iframe preview pane for a live trail row.

import { clampInViewport, startFreePixelDrag } from "./freePixelDrag";
import { scheduleFocusWhenIdle } from "./focusRestore";
import { entryTitle, entryUrlSubtitle } from "./trailPresentation";

const PREVIEW_VIEWPORT_MARGIN = 12;
const PREVIEW_GAP = 12;
const PREVIEW_SIDE_MIN_WIDTH = 460;
const PREVIEW_DESKTOP_WIDTH = 640;
const PREVIEW_DESKTOP_HEIGHT = 520;

export interface LiveTrailPreviewController {
  isOpen(): boolean;
  focusedReturnTarget(): HTMLElement | null;
  open(
    anchor: HTMLElement | null,
    entry: TrailEntry,
    onOpenInNewTab: () => void,
    returnFocus: HTMLElement | null,
  ): void;
  update(anchor: HTMLElement, entry: TrailEntry): void;
  close(restore?: boolean): void;
  reposition(): void;
}

export function createLiveTrailPreview(
  getLayer: () => HTMLElement | null,
  getBar: () => HTMLElement | null,
): LiveTrailPreviewController {
  let previewElement: HTMLDivElement | null = null;
  let previewedRowElement: HTMLElement | null = null;
  let previewManualPosition: { left: number; top: number } | null = null;
  let previewDragStop: (() => void) | null = null;
  let previewReturnFocus: HTMLElement | null = null;

  const close = (restore = false): void => {
    const returnFocus = previewReturnFocus;
    previewDragStop?.();
    previewDragStop = null;
    previewManualPosition = null;
    previewedRowElement?.classList.remove("wf-branch-row-previewed");
    previewedRowElement = null;
    if (previewElement) {
      const frame = previewElement.querySelector("iframe");
      if (frame) frame.removeAttribute("src");
      previewElement.remove();
    }
    previewElement = null;
    previewReturnFocus = null;
    if (restore) scheduleFocusWhenIdle(() => returnFocus);
  };

  const positionPreviewPane = (preview: HTMLElement): void => {
    const bar = getBar();
    if (!bar) return;
    const barRect = bar.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = PREVIEW_VIEWPORT_MARGIN;
    const availableHeight = Math.max(160, viewportHeight - margin * 2);
    const rightSpace = viewportWidth - barRect.right - PREVIEW_GAP - margin;
    const leftSpace = barRect.left - PREVIEW_GAP - margin;
    const canUseRight = viewportWidth >= 760 && rightSpace >= PREVIEW_SIDE_MIN_WIDTH;
    const canUseLeft = viewportWidth >= 760 && leftSpace >= PREVIEW_SIDE_MIN_WIDTH;

    preview.classList.remove("wf-preview-pane-bottom");

    if (previewManualPosition) {
      const rect = preview.getBoundingClientRect();
      const position = clampInViewport(
        previewManualPosition.left,
        previewManualPosition.top,
        rect.width || PREVIEW_DESKTOP_WIDTH,
        rect.height || PREVIEW_DESKTOP_HEIGHT,
        margin,
      );
      previewManualPosition = position;
      preview.style.left = `${position.left}px`;
      preview.style.top = `${position.top}px`;
      return;
    }

    preview.style.width = "";
    preview.style.height = "";
    preview.style.left = "";
    preview.style.top = "";

    if (canUseRight || canUseLeft) {
      const useRight = canUseRight && (!canUseLeft || rightSpace >= leftSpace);
      const availableWidth = useRight ? rightSpace : leftSpace;
      const width = Math.min(PREVIEW_DESKTOP_WIDTH, availableWidth);
      const height = Math.min(PREVIEW_DESKTOP_HEIGHT, availableHeight);
      const left = useRight ? barRect.right + PREVIEW_GAP : barRect.left - PREVIEW_GAP - width;
      const top = Math.min(
        Math.max(margin, barRect.top),
        Math.max(margin, viewportHeight - height - margin),
      );
      preview.style.width = `${width}px`;
      preview.style.height = `${height}px`;
      preview.style.left = `${left}px`;
      preview.style.top = `${top}px`;
      return;
    }

    preview.classList.add("wf-preview-pane-bottom");
    const width = Math.max(0, viewportWidth - margin * 2);
    const targetHeight = Math.round(viewportHeight * 0.66);
    const height = Math.min(Math.max(260, targetHeight), availableHeight);
    preview.style.width = `${width}px`;
    preview.style.height = `${height}px`;
    preview.style.left = `${margin}px`;
    preview.style.top = `${Math.max(margin, viewportHeight - height - margin)}px`;
  };

  return {
    isOpen: () => previewElement !== null,
    focusedReturnTarget: () => {
      if (!previewElement) return null;
      const root = previewElement.getRootNode();
      const active = "activeElement" in root
        ? (root as Document | ShadowRoot).activeElement
        : document.activeElement;
      return active instanceof HTMLElement && previewElement.contains(active)
        ? previewReturnFocus
        : null;
    },
    close,
    reposition: () => {
      if (previewElement) positionPreviewPane(previewElement);
    },
    update(anchor, entry) {
      if (!previewElement || previewedRowElement !== anchor) return;
      const title = previewElement.querySelector<HTMLElement>(".wf-preview-pane-title");
      const url = previewElement.querySelector<HTMLElement>(".wf-preview-pane-url");
      const frame = previewElement.querySelector<HTMLIFrameElement>("iframe");
      if (title) title.textContent = entryTitle(entry);
      if (url) url.textContent = entryUrlSubtitle(entry);
      if (frame) frame.title = `Preview: ${entryTitle(entry)}`;
    },
    open(anchor, entry, onOpenInNewTab, returnFocus) {
      const layer = getLayer();
      if (!layer) return;
      close();
      if (anchor) {
        anchor.classList.add("wf-branch-row-previewed");
        previewedRowElement = anchor;
      }

      const preview = document.createElement("div");
      preview.className = "wf-preview-pane";
      preview.dataset.tabtrailHitSurface = "";
      preview.setAttribute("role", "dialog");
      preview.setAttribute("aria-modal", "false");

      const header = document.createElement("div");
      header.className = "wf-preview-pane-header";

      const identity = document.createElement("div");
      identity.className = "wf-preview-pane-identity";

      const kicker = document.createElement("div");
      kicker.className = "wf-preview-pane-kicker";
      kicker.textContent = "Preview";
      identity.appendChild(kicker);

      const title = document.createElement("div");
      title.id = "tabtrail-live-preview-title";
      title.className = "wf-preview-pane-title";
      title.textContent = entryTitle(entry);
      identity.appendChild(title);

      const url = document.createElement("div");
      url.id = "tabtrail-live-preview-url";
      url.className = "wf-preview-pane-url";
      url.textContent = entryUrlSubtitle(entry);
      identity.appendChild(url);
      preview.setAttribute("aria-labelledby", title.id);
      preview.setAttribute("aria-describedby", url.id);

      const actions = document.createElement("div");
      actions.className = "wf-preview-pane-actions";

      const drag = document.createElement("span");
      drag.className = "wf-preview-pane-drag";
      drag.textContent = "⠿";
      drag.title = "Move preview pane";
      drag.setAttribute("aria-hidden", "true");
      drag.addEventListener("pointerdown", (event) => {
        if (!previewElement) return;
        previewElement.classList.remove("wf-preview-pane-bottom");
        previewDragStop?.();
        previewDragStop = startFreePixelDrag(previewElement, event, {
          draggingClass: "wf-preview-pane-dragging",
          onMove: (position) => {
            previewManualPosition = position;
          },
          onEnd: () => {
            previewDragStop = null;
          },
        });
      });

      const open = document.createElement("button");
      open.className = "wf-preview-pane-action";
      open.type = "button";
      open.textContent = "↗";
      open.title = "Open in new tab";
      open.setAttribute("aria-label", "Open previewed page in a new tab");
      open.addEventListener("click", () => onOpenInNewTab());

      const closeBtn = document.createElement("button");
      closeBtn.className = "wf-preview-pane-close";
      closeBtn.type = "button";
      closeBtn.textContent = "✕";
      closeBtn.title = "Close preview";
      closeBtn.setAttribute("aria-label", "Close page preview");
      closeBtn.addEventListener("click", () => close(true));

      actions.appendChild(drag);
      actions.appendChild(open);
      actions.appendChild(closeBtn);

      header.appendChild(identity);
      header.appendChild(actions);

      const frame = document.createElement("iframe");
      frame.className = "wf-preview-pane-frame";
      frame.title = `Preview: ${entryTitle(entry)}`;
      frame.referrerPolicy = "no-referrer";
      // Scripts without same-origin keeps the preview from escaping its sandbox
      // when the trail URL is same-site.
      frame.setAttribute("sandbox", "allow-forms allow-popups allow-scripts");
      frame.src = entry.url;

      preview.appendChild(header);
      preview.appendChild(frame);
      layer.appendChild(preview);
      positionPreviewPane(preview);
      previewElement = preview;
      previewReturnFocus = returnFocus;
      closeBtn.focus({ preventScroll: true });
    },
  };
}
