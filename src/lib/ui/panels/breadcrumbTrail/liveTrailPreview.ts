// Draggable iframe preview pane for a live trail row. Lifecycle is always
// honest: loading → ready, or an explicit blocked/timeout/error fallback — never
// a silent blank frame.

import {
  probePreviewFramability,
  type PreviewProbeResult,
} from "../../../core/trail/previewFraming";
import { clampInViewport, startFreePixelDrag } from "./freePixelDrag";
import { scheduleFocusWhenIdle } from "./focusRestore";
import { entryTitle, entryUrlSubtitle } from "./trailPresentation";

const PREVIEW_VIEWPORT_MARGIN = 12;
const PREVIEW_GAP = 12;
const PREVIEW_SIDE_MIN_WIDTH = 460;
const PREVIEW_DESKTOP_WIDTH = 640;
const PREVIEW_DESKTOP_HEIGHT = 520;
/** How long to wait for iframe load when preflight is unknown or allows. */
const PREVIEW_LOAD_TIMEOUT_MS = 7000;

export type LivePreviewBodyState = "loading" | "ready" | "blocked" | "timeout" | "error";

export interface LiveTrailPreviewActions {
  onOpenInNewTab: () => void;
  onJump: () => void;
  onCopyUrl?: () => void;
}

export interface LiveTrailPreviewController {
  isOpen(): boolean;
  focusedReturnTarget(): HTMLElement | null;
  open(
    anchor: HTMLElement | null,
    entry: TrailEntry,
    actions: LiveTrailPreviewActions,
    returnFocus: HTMLElement | null,
  ): void;
  update(anchor: HTMLElement, entry: TrailEntry): void;
  close(restore?: boolean): void;
  reposition(): void;
}

function fallbackCopy(state: Exclude<LivePreviewBodyState, "loading" | "ready">): {
  title: string;
  detail: string;
} {
  if (state === "blocked") {
    return {
      title: "Live preview unavailable",
      detail: "This site blocks embedding, so a live preview isn’t available.",
    };
  }
  if (state === "timeout") {
    return {
      title: "Preview timed out",
      detail: "The page took too long to load in the preview.",
    };
  }
  return {
    title: "Preview couldn’t load",
    detail: "The preview failed to load.",
  };
}

export interface LiveTrailPreviewDeps {
  /** Override network probe (tests); defaults to real header probe. */
  probeFramability?: (
    url: string,
    embedderOrigin: string,
  ) => Promise<PreviewProbeResult>;
}

export function createLiveTrailPreview(
  getLayer: () => HTMLElement | null,
  getBar: () => HTMLElement | null,
  deps: LiveTrailPreviewDeps = {},
): LiveTrailPreviewController {
  const probe = deps.probeFramability ?? probePreviewFramability;
  let previewElement: HTMLDivElement | null = null;
  let previewedRowElement: HTMLElement | null = null;
  let previewManualPosition: { left: number; top: number } | null = null;
  let previewDragStop: (() => void) | null = null;
  let previewReturnFocus: HTMLElement | null = null;
  let bodyState: LivePreviewBodyState = "loading";
  let loadTimeoutId = 0;
  let openGeneration = 0;
  let activeEntry: TrailEntry | null = null;
  let activeActions: LiveTrailPreviewActions | null = null;

  const clearLoadTimeout = (): void => {
    if (loadTimeoutId !== 0) {
      window.clearTimeout(loadTimeoutId);
      loadTimeoutId = 0;
    }
  };

  const close = (restore = false): void => {
    openGeneration += 1;
    clearLoadTimeout();
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
    activeEntry = null;
    activeActions = null;
    bodyState = "loading";
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

  const bodyHost = (): HTMLElement | null =>
    previewElement?.querySelector<HTMLElement>(".wf-preview-pane-body") ?? null;

  const setBodyState = (
    next: LivePreviewBodyState,
    detailOverride?: string,
  ): void => {
    const host = bodyHost();
    if (!host || !previewElement) return;
    bodyState = next;
    previewElement.dataset.previewState = next;

    // Ready keeps the iframe already mounted in the host — never wipe children.
    if (next === "ready") {
      return;
    }

    // Loading and fallbacks rebuild exclusive body content.
    host.textContent = "";

    if (next === "loading") {
      const loading = document.createElement("div");
      loading.className = "wf-preview-pane-loading";
      loading.setAttribute("role", "status");
      loading.setAttribute("aria-live", "polite");
      const spinner = document.createElement("div");
      spinner.className = "wf-preview-pane-spinner";
      spinner.setAttribute("aria-hidden", "true");
      const label = document.createElement("div");
      label.className = "wf-preview-pane-loading-label";
      label.textContent = "Loading preview…";
      loading.appendChild(spinner);
      loading.appendChild(label);
      host.appendChild(loading);
      return;
    }

    const copy = fallbackCopy(next);
    const fallback = document.createElement("div");
    fallback.className = "wf-preview-pane-fallback";
    fallback.setAttribute("role", "status");
    fallback.setAttribute("aria-live", "polite");

    const title = document.createElement("strong");
    title.className = "wf-preview-pane-fallback-title";
    title.textContent = copy.title;
    fallback.appendChild(title);

    const detail = document.createElement("p");
    detail.className = "wf-preview-pane-fallback-detail";
    detail.textContent = detailOverride || copy.detail;
    fallback.appendChild(detail);

    const actions = document.createElement("div");
    actions.className = "wf-preview-pane-fallback-actions";

    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "wf-preview-pane-fallback-action";
    jump.textContent = "Open in this tab";
    jump.addEventListener("click", () => activeActions?.onJump());
    actions.appendChild(jump);

    const openTab = document.createElement("button");
    openTab.type = "button";
    openTab.className = "wf-preview-pane-fallback-action wf-preview-pane-fallback-action-primary";
    openTab.textContent = "Open in new tab";
    openTab.addEventListener("click", () => activeActions?.onOpenInNewTab());
    actions.appendChild(openTab);

    if (activeActions?.onCopyUrl) {
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "wf-preview-pane-fallback-action";
      copyBtn.textContent = "Copy URL";
      copyBtn.addEventListener("click", () => activeActions?.onCopyUrl?.());
      actions.appendChild(copyBtn);
    }

    fallback.appendChild(actions);
    host.appendChild(fallback);
  };

  const attachIframe = (url: string, title: string, generation: number): void => {
    const host = bodyHost();
    if (!host || generation !== openGeneration) return;
    setBodyState("loading");

    const frame = document.createElement("iframe");
    frame.className = "wf-preview-pane-frame";
    frame.hidden = true;
    frame.title = `Preview: ${title}`;
    frame.referrerPolicy = "no-referrer";
    // Scripts without same-origin keeps the preview from escaping its sandbox
    // when the trail URL is same-site.
    frame.setAttribute("sandbox", "allow-forms allow-popups allow-scripts");

    // Only treat loads after the intentional trail URL is assigned. Appending
    // an iframe without src commonly fires load for about:blank and would
    // otherwise mark the pane "ready" blank and cancel the timeout.
    let navigationStarted = false;

    const finishReady = (): void => {
      if (generation !== openGeneration || !previewElement) return;
      clearLoadTimeout();
      setBodyState("ready");
      const loading = host.querySelector(".wf-preview-pane-loading");
      loading?.remove();
      frame.hidden = false;
    };

    const finishTimeout = (): void => {
      if (generation !== openGeneration || bodyState === "ready") return;
      frame.removeAttribute("src");
      frame.remove();
      setBodyState("timeout");
    };

    frame.addEventListener("load", () => {
      if (generation !== openGeneration || !navigationStarted) return;
      // Ignore intermediate about:blank when the document is readable.
      try {
        const href = frame.contentWindow?.location?.href ?? "";
        if (href === "about:blank" || href === "") return;
      } catch (_) {
        // Cross-origin: real navigation committed (or opaque blocked empty).
      }
      // Preflight already filtered hard "no". Cross-origin load is the best
      // ready signal available; opaque blocked empties that still fire load
      // remain a residual honesty gap. Timeout is the backstop when no load
      // ever fires.
      finishReady();
    });
    frame.addEventListener("error", () => {
      if (generation !== openGeneration || bodyState === "ready") return;
      clearLoadTimeout();
      frame.remove();
      setBodyState("error");
    });

    // Assign src before insert so the first in-document navigation is the
    // trail URL, not a bare about:blank insertion.
    navigationStarted = true;
    frame.src = url;
    host.appendChild(frame);
    clearLoadTimeout();
    loadTimeoutId = window.setTimeout(finishTimeout, PREVIEW_LOAD_TIMEOUT_MS);
  };

  const applyProbe = (probe: PreviewProbeResult, entry: TrailEntry, generation: number): void => {
    if (generation !== openGeneration) return;
    if (probe.framable === "no") {
      clearLoadTimeout();
      setBodyState("blocked", probe.reason);
      return;
    }
    attachIframe(entry.url, entryTitle(entry), generation);
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
      activeEntry = entry;
      const title = previewElement.querySelector<HTMLElement>(".wf-preview-pane-title");
      const url = previewElement.querySelector<HTMLElement>(".wf-preview-pane-url");
      const frame = previewElement.querySelector<HTMLIFrameElement>("iframe");
      if (title) title.textContent = entryTitle(entry);
      if (url) url.textContent = entryUrlSubtitle(entry);
      if (frame) frame.title = `Preview: ${entryTitle(entry)}`;
    },
    open(anchor, entry, actions, returnFocus) {
      const layer = getLayer();
      if (!layer) return;
      close();
      const generation = openGeneration;
      activeEntry = entry;
      activeActions = actions;
      if (anchor) {
        anchor.classList.add("wf-branch-row-previewed");
        previewedRowElement = anchor;
      }

      const preview = document.createElement("div");
      preview.className = "wf-preview-pane";
      preview.dataset.tabtrailHitSurface = "";
      preview.dataset.previewState = "loading";
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

      const headerActions = document.createElement("div");
      headerActions.className = "wf-preview-pane-actions";

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
      open.addEventListener("click", () => actions.onOpenInNewTab());

      const closeBtn = document.createElement("button");
      closeBtn.className = "wf-preview-pane-close";
      closeBtn.type = "button";
      closeBtn.textContent = "✕";
      closeBtn.title = "Close preview";
      closeBtn.setAttribute("aria-label", "Close page preview");
      closeBtn.addEventListener("click", () => close(true));

      headerActions.appendChild(drag);
      headerActions.appendChild(open);
      headerActions.appendChild(closeBtn);

      header.appendChild(identity);
      header.appendChild(headerActions);

      const body = document.createElement("div");
      body.className = "wf-preview-pane-body";

      preview.appendChild(header);
      preview.appendChild(body);
      layer.appendChild(preview);
      positionPreviewPane(preview);
      previewElement = preview;
      previewReturnFocus = returnFocus;
      setBodyState("loading");
      closeBtn.focus({ preventScroll: true });

      // Extension-origin document can probe with host permissions; pure assess
      // stays testable offline.
      void Promise.resolve(probe(entry.url, window.location.origin))
        .then((result) => applyProbe(result, entry, generation))
        .catch(() => {
          if (generation !== openGeneration) return;
          // Inconclusive probe → still try the iframe with timeout.
          applyProbe({ framable: "unknown" }, entry, generation);
        });
    },
  };
}

