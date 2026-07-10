// Shared non-stealing focus handoff for in-shadow overlay surfaces. Callers
// resolve their logical replacement after any synchronous rerender; focus is
// applied in a microtask only when no other connected control took focus.

export function scheduleFocusWhenIdle(
  resolve: () => HTMLElement | null,
): void {
  queueMicrotask(() => {
    const target = resolve();
    if (
      !target?.isConnected ||
      target.matches(":disabled") ||
      target.inert ||
      target.closest("[inert]") !== null
    ) return;

    const root = target.getRootNode();
    const rootActive = "activeElement" in root
      ? (root as Document | ShadowRoot).activeElement
      : null;
    if (rootActive === target) return;

    const ownerDocument = target.ownerDocument;
    const shadowHost = "host" in root ? (root as ShadowRoot).host : null;
    const hasMeaningfulFocus = (active: Element | null): boolean => (
      active instanceof HTMLElement &&
      active.isConnected &&
      active !== ownerDocument.body &&
      active !== ownerDocument.documentElement &&
      active !== shadowHost
    );
    if (
      hasMeaningfulFocus(rootActive) ||
      hasMeaningfulFocus(ownerDocument.activeElement)
    ) return;

    target.focus({ preventScroll: true });
  });
}
