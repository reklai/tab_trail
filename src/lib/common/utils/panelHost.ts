// Shadow DOM panel host — creates an isolated overlay container so panel
// markup and styles stay separate from the page. Panels are non-modal: the
// page keeps focus except while an explicit panel control is being used.

export interface PanelHost {
  host: HTMLDivElement;
  shadow: ShadowRoot;
}

// Active panel cleanup — called before opening a new panel so the previous
// panel's keydown listener (registered on document) is properly removed.
let activePanelCleanup: (() => void) | null = null;
let activePanelFailSafeCleanup: (() => void) | null = null;

function invokeCleanupSafely(
  label: string,
  cleanup: (() => void) | null,
): void {
  if (!cleanup) return;
  try {
    cleanup();
  } catch (error) {
    console.error(`[TabTrail] ${label}:`, error);
  }
}

function cleanupPanelFailSafe(): void {
  const cleanup = activePanelFailSafeCleanup;
  activePanelFailSafeCleanup = null;
  invokeCleanupSafely("Panel fail-safe cleanup failed", cleanup);
}

function handlePanelRuntimeFault(label: string, reason: unknown): void {
  if (!document.getElementById("ht-panel-host")) return;
  console.error(`[TabTrail] ${label}; dismissing panel.`, reason);
  // Defer dismiss to the next frame so the current error path can unwind
  // before the host is torn down.
  requestAnimationFrame(() => {
    if (document.getElementById("ht-panel-host")) dismissPanel();
  });
}

const EXTENSION_ORIGIN_PATTERN = /(?:chrome|moz|safari-web)-extension:\/\/[^/\s)]+/i;

function extensionOriginIn(value: string): string | null {
  return value.match(EXTENSION_ORIGIN_PATTERN)?.[0] ?? null;
}

// Capture this bundle's extension origin without calling a privileged runtime
// API. Stack URLs are present in extension content scripts in both Chromium
// and Firefox; the scheme fallback keeps fail-safe handling available when a
// browser omits the initialization stack URL.
const PANEL_EXTENSION_ORIGIN = extensionOriginIn(new Error().stack ?? "");

function valueLooksExtensionScoped(value: string): boolean {
  if (PANEL_EXTENSION_ORIGIN) return value.includes(PANEL_EXTENSION_ORIGIN);
  return EXTENSION_ORIGIN_PATTERN.test(value);
}

function reasonLooksExtensionScoped(reason: unknown): boolean {
  if (!reason) return false;
  if (typeof reason === "string") return valueLooksExtensionScoped(reason);
  if (typeof reason === "object") {
    const maybeError = reason as { stack?: unknown; message?: unknown };
    if (typeof maybeError.stack === "string" && valueLooksExtensionScoped(maybeError.stack)) {
      return true;
    }
    if (typeof maybeError.message === "string" && valueLooksExtensionScoped(maybeError.message)) {
      return true;
    }
  }
  return false;
}

function isPanelRuntimeFaultFromExtension(event: ErrorEvent): boolean {
  if (typeof event.filename === "string" && valueLooksExtensionScoped(event.filename)) {
    return true;
  }
  if (reasonLooksExtensionScoped(event.error)) return true;
  return reasonLooksExtensionScoped(event.message);
}

/** Register a cleanup function for the currently open panel.
 *  Called by each overlay after setup so createPanelHost can tear it down. */
export function registerPanelCleanup(fn: () => void): void {
  activePanelCleanup = fn;
}

/** Create a full-viewport Shadow DOM host for overlay panels.
 *  Cleans up and removes any existing panel first — only one panel at a time. */
export function createPanelHost(): PanelHost {
  // Clean up previous panel's event listeners before removing DOM
  if (activePanelCleanup) {
    const cleanup = activePanelCleanup;
    activePanelCleanup = null;
    invokeCleanupSafely("Panel cleanup failed while opening a new panel", cleanup);
  }
  cleanupPanelFailSafe();
  const existing = document.getElementById("ht-panel-host");
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = "ht-panel-host";
  host.style.cssText =
    "position:fixed;inset:0;width:100vw;height:100vh;width:100dvw;height:100dvh;z-index:2147483647;pointer-events:auto;overflow:hidden;overscroll-behavior:none;isolation:isolate;";
  const shadow = host.attachShadow({ mode: "open" });
  document.body.appendChild(host);

  const onError = (event: ErrorEvent): void => {
    if (!isPanelRuntimeFaultFromExtension(event)) return;
    handlePanelRuntimeFault("Panel runtime error", event.error || event.message);
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    if (!reasonLooksExtensionScoped(event.reason)) return;
    handlePanelRuntimeFault("Panel unhandled rejection", event.reason);
  };

  // The live trail now runs inside an extension-origin iframe. A continuous
  // rAF stall probe is unnecessary there (the host frame already heartbeats).
  // Keep lightweight error/rejection fail-safes only.
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  activePanelFailSafeCleanup = () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };

  return { host, shadow };
}

export function removePanelHost(): void {
  cleanupPanelFailSafe();
  const host = document.getElementById("ht-panel-host");
  if (host) host.remove();
  activePanelCleanup = null;
}

/** Fully dismiss the active panel — cleanup listeners + remove DOM. */
export function dismissPanel(): void {
  const cleanup = activePanelCleanup;
  activePanelCleanup = null;
  invokeCleanupSafely("Panel cleanup failed during dismiss", cleanup);
  removePanelHost();
}

/** Shared design tokens + minimal reset for overlay panels. */
export function getBaseStyles(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }

    :host {
      all: initial;
      --ht-font-mono: 'SF Mono', 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
      --ht-color-bg: #1e1e1e;
      --ht-color-bg-elevated: #252525;
      --ht-color-bg-soft: #3a3a3c;
      --ht-color-bg-detail-focus: #1a2230;
      --ht-color-bg-detail-focus-header: #1e2a3a;
      --ht-color-bg-code: #1a1a1a;
      --ht-color-text: #e0e0e0;
      --ht-color-text-soft: #c0c0c0;
      --ht-color-text-muted: #808080;
      --ht-color-text-title: #a0a0a0;
      --ht-color-text-detail-focus: #a0c0e0;
      --ht-color-text-dim: #666;
      --ht-color-text-faint: #555;
      --ht-color-text-strong: #fff;
      --ht-color-accent: #0a84ff;
      --ht-color-accent-soft: rgba(10,132,255,0.1);
      --ht-color-accent-active: rgba(10,132,255,0.15);
      --ht-color-accent-soft-strong: rgba(10,132,255,0.12);
      --ht-color-accent-soft-faint: rgba(10,132,255,0.08);
      --ht-color-accent-alt: #af82ff;
      --ht-color-accent-alt-soft: rgba(175,130,255,0.15);
      --ht-color-success: #32d74b;
      --ht-color-tree-cursor: #4ec970;
      --ht-color-tree-cursor-bg: rgba(78,201,112,0.15);
      --ht-color-tree-cursor-bg-soft: rgba(78,201,112,0.18);
      --ht-color-tree-cursor-bg-strong: rgba(78,201,112,0.20);
      --ht-color-danger: #ff5f57;
      --ht-color-warning: #febc2e;
      --ht-color-mark-bg: #f9d45c;
      --ht-color-mark-fg: #1e1e1e;
      --ht-color-border: transparent;
      --ht-color-border-soft: transparent;
      --ht-color-border-faint: transparent;
      --ht-color-border-ultra-faint: transparent;
      --ht-color-hover: rgba(255,255,255,0.06);
      --ht-color-focus-active: rgba(255,255,255,0.13);
      --ht-color-surface: rgba(255,255,255,0.08);
      --ht-color-surface-dim: rgba(255,255,255,0.04);
      --ht-color-surface-strong: rgba(255,255,255,0.15);
      --ht-shadow-overlay: none;
      --ht-radius: 10px;
      font-family: var(--ht-font-mono);
      font-size: 13px;
      color: var(--ht-color-text);
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }

    input,
    textarea {
      user-select: text;
      -webkit-user-select: text;
    }

    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
    }
  `;
}
