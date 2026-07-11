declare global {
  interface Window {
    __tabtrailCleanup?: () => void;
  }
}

type BootstrapCleanupKey =
  | "__tabtrailCleanup"
  | "__tabtrailChordCleanup"
  | "__tabtrailTopCleanup";

type BootstrapWindow = Window & Partial<Record<BootstrapCleanupKey, () => void>>;

/** Best-effort retirement for a bootstrap that may belong to an invalidated context. */
export function retireBootstrapCleanup(cleanupKey: BootstrapCleanupKey): void {
  const bootstrapWindow = window as BootstrapWindow;
  const cleanup = bootstrapWindow[cleanupKey];
  if (!cleanup) return;
  try {
    cleanup();
  } catch (_) {
    // An update can invalidate the old extension context before cleanup runs.
  } finally {
    delete bootstrapWindow[cleanupKey];
  }
}

/** Retires the combined content-script bootstrap used before the bundle split. */
export function retireLegacyCombinedBootstrap(): void {
  retireBootstrapCleanup("__tabtrailCleanup");
}
