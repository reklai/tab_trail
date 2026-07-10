// Ordered stack of secondary overlay surfaces (menus, dialogs, panels).
// Esc dismisses the topmost surface; openers push with a close callback that
// only tears down DOM — the stack entry is removed by closeSurface/closeTop.

export interface OverlaySurface {
  id: string;
  close: () => void;
}

const stack: OverlaySurface[] = [];

export function hasOverlaySurface(id: string): boolean {
  return stack.some((surface) => surface.id === id);
}

export function isOverlaySurfaceBlockingLiveRender(): boolean {
  return hasOverlaySurface("nameDialog") || hasOverlaySurface("library");
}

export function pushOverlaySurface(id: string, close: () => void): void {
  closeOverlaySurface(id);
  stack.push({ id, close });
}

export function closeOverlaySurface(id: string): void {
  const index = stack.findIndex((surface) => surface.id === id);
  if (index === -1) return;
  const [surface] = stack.splice(index, 1);
  surface.close();
}

/** Remove a stack entry without invoking close (caller already tore down DOM). */
export function dropOverlaySurface(id: string): void {
  const index = stack.findIndex((surface) => surface.id === id);
  if (index === -1) return;
  stack.splice(index, 1);
}

/** Dismiss the innermost surface. Returns true when something closed. */
export function closeTopOverlaySurface(): boolean {
  const surface = stack.pop();
  if (!surface) return false;
  surface.close();
  return true;
}

export function closeAllOverlaySurfaces(): void {
  while (stack.length > 0) {
    const surface = stack.pop();
    surface?.close();
  }
}
