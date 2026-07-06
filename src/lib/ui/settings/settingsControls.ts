// Shared settings-controls used by both the toolbar popup and the options page,
// so the two surfaces always render the same option lists and capture the
// trigger shortcut the same way.

import {
  formatTabTrailModifierKey,
  formatTriggerKeyLabel,
  formatTriggerMouseLabel,
  isValidTriggerKeyCode,
  isValidTriggerMouseButton,
  TABTRAIL_MODIFIER_KEYS,
} from "../../common/contracts/tabtrail";

export function populateModifierSelect(
  select: HTMLSelectElement,
  selected: TabTrailModifierKey,
): void {
  select.textContent = "";
  for (const modifier of TABTRAIL_MODIFIER_KEYS) {
    const option = document.createElement("option");
    option.value = modifier;
    option.textContent = formatTabTrailModifierKey(modifier);
    if (modifier === selected) option.selected = true;
    select.appendChild(option);
  }
}

// The trigger half that a capture gesture produced: either a keyboard code or a
// mouse button.
export type TriggerCapturePatch =
  | { kind: "key"; keyCode: string }
  | { kind: "mouse"; mouseButton: number };

export interface ShortcutCaptureController {
  isCapturing(): boolean;
  // Show the current trigger on the button when not mid-capture.
  showTrigger(trigger: TabTrailTrigger): void;
}

// How long to keep swallowing the follow-up events a capture gesture spawns.
// The click that bound a mouse button must not also activate the button, and a
// right-click must not open the native context menu — which the browser fires
// AFTER the mousedown, so the suppressor has to outlive the capture teardown.
const CAPTURE_FOLLOWUP_SUPPRESS_MS = 300;

function triggerButtonLabel(trigger: TabTrailTrigger): string {
  return trigger.kind === "mouse"
    ? formatTriggerMouseLabel(trigger.mouseButton)
    : formatTriggerKeyLabel(trigger.keyCode);
}

// Wires a "click to capture a shortcut" button: it listens for the next key or
// mouse button and reports it through onCapture. Encapsulates the follow-up
// suppression so both settings surfaces stay in sync and correct.
export function createShortcutCaptureController(
  button: HTMLElement,
  onCapture: (patch: TriggerCapturePatch) => void,
): ShortcutCaptureController {
  let capturing = false;
  let suppressNextClick = false;

  function onKeydown(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopCapture();
      return;
    }
    if (isValidTriggerKeyCode(event.code)) {
      stopCapture();
      onCapture({ kind: "key", keyCode: event.code });
    }
    // Modifier-only presses keep the capture open until a valid key arrives.
  }

  function onMousedown(event: MouseEvent): void {
    if (!isValidTriggerMouseButton(event.button)) return;
    event.preventDefault();
    event.stopPropagation();
    suppressNextClick = true;
    window.setTimeout(() => {
      suppressNextClick = false;
    }, CAPTURE_FOLLOWUP_SUPPRESS_MS);
    // Keep the contextmenu suppressor installed a moment longer: a right-click
    // dispatches contextmenu AFTER this mousedown, so tearing it down now would
    // let the native menu through.
    stopCapture(true);
    onCapture({ kind: "mouse", mouseButton: event.button });
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  function startCapture(): void {
    if (capturing) return;
    capturing = true;
    button.textContent = "Press key / click";
    button.classList.add("is-capturing");
    // Defer one tick so the click that opened the capture does not cancel it.
    window.setTimeout(() => {
      if (!capturing) return;
      window.addEventListener("keydown", onKeydown, true);
      window.addEventListener("mousedown", onMousedown, true);
      window.addEventListener("contextmenu", onContextMenu, true);
    }, 0);
  }

  function stopCapture(keepContextMenuGuard = false): void {
    if (!capturing) return;
    capturing = false;
    window.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("mousedown", onMousedown, true);
    if (keepContextMenuGuard) {
      // Remove the suppressor once the right-click's contextmenu has passed —
      // but skip it if a new capture has started in the meantime, which would
      // have re-added the same listener and still needs it.
      window.setTimeout(() => {
        if (!capturing) window.removeEventListener("contextmenu", onContextMenu, true);
      }, CAPTURE_FOLLOWUP_SUPPRESS_MS);
    } else {
      window.removeEventListener("contextmenu", onContextMenu, true);
    }
  }

  button.addEventListener("click", (event) => {
    if (suppressNextClick) {
      event.preventDefault();
      event.stopPropagation();
      suppressNextClick = false;
      return;
    }
    startCapture();
  });

  return {
    isCapturing(): boolean {
      return capturing;
    },
    showTrigger(trigger: TabTrailTrigger): void {
      if (capturing) return;
      button.textContent = triggerButtonLabel(trigger);
      button.classList.remove("is-capturing");
    },
  };
}
