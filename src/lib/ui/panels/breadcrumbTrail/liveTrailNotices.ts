// Transient status + independent undo notices stacked beside the live trail.

import { scheduleFocusWhenIdle } from "./focusRestore";
import type { SavedTrailsNoticeOptions } from "./savedTrailsSession";

export interface LiveNoticeHost {
  shadow: ShadowRoot;
  layer: HTMLElement;
  bar: HTMLElement;
  noticeStack: HTMLDivElement;
  statusNoticeCleanup: (() => void) | null;
  undoNoticeCleanups: Set<() => void>;
}

export function clearLiveNotices(host: LiveNoticeHost | null | undefined): void {
  if (!host) return;
  host.statusNoticeCleanup?.();
  for (const cleanup of host.undoNoticeCleanups) cleanup();
  host.undoNoticeCleanups.clear();
  host.statusNoticeCleanup = null;
}

function restoreFocusAfterNotice(host: LiveNoticeHost): void {
  scheduleFocusWhenIdle(() => {
    const target =
      host.noticeStack.querySelector<HTMLElement>(".wf-notice-action:not(:disabled)") ??
      host.layer.querySelector<HTMLElement>(".wf-library-search") ??
      host.layer.querySelector<HTMLElement>(".wf-library-row .wf-row-more") ??
      host.bar.querySelector<HTMLElement>("[data-live-control=library]");
    return target;
  });
}

export function showLiveNotice(
  host: LiveNoticeHost,
  isStillHost: () => boolean,
  message: string,
  options: SavedTrailsNoticeOptions = {},
): void {
  if (!isStillHost()) return;
  const undoLane = options.undo === true;
  if (!undoLane) host.statusNoticeCleanup?.();

  const notice = document.createElement("div");
  notice.className = `wf-notice wf-notice-${options.tone ?? "info"} ${
    undoLane ? "wf-notice-undo" : "wf-notice-status"
  }`;
  notice.dataset.tabtrailHitSurface = "";
  notice.setAttribute("role", options.tone === "error" ? "alert" : "status");
  notice.setAttribute("aria-live", options.tone === "error" ? "assertive" : "polite");

  const copy = document.createElement("span");
  copy.className = "wf-notice-copy";
  copy.textContent = message;
  notice.appendChild(copy);

  if (options.actionLabel && options.action) {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "wf-notice-action";
    action.textContent = options.actionLabel;
    action.addEventListener("click", () => {
      if (!options.action || action.disabled) return;
      action.disabled = true;
      action.textContent = "Working…";
      void Promise.resolve(options.action()).then(() => {
        if (notice.isConnected) remove();
      }).catch(() => {
        if (isStillHost()) {
          showLiveNotice(host, isStillHost, "Action failed", { tone: "error", durationMs: 5000 });
        }
      });
    });
    notice.appendChild(action);
  }
  if (undoLane) {
    host.noticeStack.appendChild(notice);
  } else {
    host.noticeStack.prepend(notice);
  }

  let remainingMs = options.durationMs ?? (options.action ? 8000 : 2200);
  let startedAt = Date.now();
  let timer: number | null = null;
  const remove = (): void => {
    const ownedFocus = notice.contains(host.shadow.activeElement);
    if (timer != null) window.clearTimeout(timer);
    timer = null;
    notice.remove();
    if (undoLane) {
      host.undoNoticeCleanups.delete(remove);
    } else if (host.statusNoticeCleanup === remove) {
      host.statusNoticeCleanup = null;
    }
    if (ownedFocus) restoreFocusAfterNotice(host);
  };
  const resume = (): void => {
    if (timer != null || remainingMs <= 0) return;
    startedAt = Date.now();
    timer = window.setTimeout(remove, remainingMs);
  };
  const pause = (): void => {
    if (timer == null) return;
    window.clearTimeout(timer);
    timer = null;
    remainingMs = Math.max(0, remainingMs - (Date.now() - startedAt));
  };
  notice.addEventListener("mouseenter", pause);
  notice.addEventListener("mouseleave", resume);
  notice.addEventListener("focusin", pause);
  notice.addEventListener("focusout", resume);
  if (undoLane) host.undoNoticeCleanups.add(remove);
  else host.statusNoticeCleanup = remove;
  resume();
}
