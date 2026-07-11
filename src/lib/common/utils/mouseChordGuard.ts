// Capture-phase swallow for the click/auxclick/contextmenu events that follow
// a matched mouse toggle chord. Shared by the content-script host and the
// isolated overlay frame so chord policy cannot drift.

import {
  isMouseChordFollowUp,
  MOUSE_CHORD_SWALLOW_WINDOW_MS,
} from "../../core/trail/trailCore";

export interface MouseChordGuard {
  arm(mouseButton: number): void;
  dispose(): void;
}

export function installMouseChordGuard(
  target: Window | Document = window,
  windowMs: number = MOUSE_CHORD_SWALLOW_WINDOW_MS,
): MouseChordGuard {
  let swallowUntil = 0;
  let swallowedButton = -1;

  const onFollowUp = (event: Event): void => {
    if (!(event instanceof MouseEvent)) return;
    if (performance.now() > swallowUntil) return;
    if (!isMouseChordFollowUp(event, swallowedButton)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  target.addEventListener("auxclick", onFollowUp, true);
  target.addEventListener("click", onFollowUp, true);
  target.addEventListener("contextmenu", onFollowUp, true);

  return {
    arm(mouseButton: number): void {
      swallowUntil = performance.now() + windowMs;
      swallowedButton = mouseButton;
    },
    dispose(): void {
      swallowUntil = 0;
      swallowedButton = -1;
      target.removeEventListener("auxclick", onFollowUp, true);
      target.removeEventListener("click", onFollowUp, true);
      target.removeEventListener("contextmenu", onFollowUp, true);
    },
  };
}
