// Combined entry kept for temporary inject/reload compatibility. Prefer the
// split chord + top entries so subframes never parse the overlay host stack.
//
// Removal condition (see contentScriptActivation.ts): drop this bundle only
// after split injects succeed reliably across supported browsers for at least
// one release cycle and no upgrade path still depends on the single-file entry.
// Until then, do not add new behavior only here — mirror it in the split entries.

import { initChordCapture } from "../../lib/appInit/chordCapture";
import { initTopFrameOverlay } from "../../lib/appInit/topFrameOverlay";

initChordCapture();
initTopFrameOverlay();
