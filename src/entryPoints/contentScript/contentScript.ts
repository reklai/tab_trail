// Combined entry kept for temporary inject/reload compatibility. Prefer the
// split chord + top entries so subframes never parse the overlay host stack.

import { initChordCapture } from "../../lib/appInit/chordCapture";
import { initTopFrameOverlay } from "../../lib/appInit/topFrameOverlay";

initChordCapture();
initTopFrameOverlay();
