// Client-side runtime messaging: extension surfaces (popup, options, content
// script) send messages to the background service worker through here.
//
// The retry variant handles one MV3 quirk: just after the worker spins up,
// sendMessage can reject with "receiving end does not exist" because the
// worker's onMessage listener isn't registered yet. Retrying rides that out.
//
// It retries ONLY that missing-receiver error, deliberately. Any other
// rejection might mean the worker received and ran the message but died before
// replying — re-sending would run the action a second time. Scoping retries to
// the "never reached the worker" case keeps non-idempotent gestures (jump,
// open-in-new-tab) safe on the retry variant.

import browser from "webextension-polyfill";
import { BackgroundRuntimeMessage } from "../../common/contracts/runtimeMessages";
import { sleep } from "../../common/utils/asyncFlow";

export interface RuntimeRetryPolicy {
  retryDelaysMs: number[];
}

export const DEFAULT_RUNTIME_RETRY_POLICY: RuntimeRetryPolicy = {
  retryDelaysMs: [0, 80, 220, 420],
};

// True for the "no listener reachable" errors browsers raise when the service
// worker hasn't registered onMessage yet — the only case where re-sending is
// guaranteed not to repeat an already-applied action.
function isReceiverUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return (
    lowered.includes("receiving end does not exist") ||
    lowered.includes("could not establish connection")
  );
}

export async function sendRuntimeMessage<T>(
  message: BackgroundRuntimeMessage,
): Promise<T> {
  return (await browser.runtime.sendMessage(message)) as T;
}

export async function sendRuntimeMessageWithRetry<T>(
  message: BackgroundRuntimeMessage,
  policy: RuntimeRetryPolicy = DEFAULT_RUNTIME_RETRY_POLICY,
): Promise<T> {
  let lastError: unknown = null;
  for (const delay of policy.retryDelaysMs) {
    if (delay > 0) {
      await sleep(delay);
    }

    try {
      return await sendRuntimeMessage<T>(message);
    } catch (error) {
      lastError = error;
      // Only a cold, not-yet-listening worker is safe to retry; anything else
      // may have already run the action, so don't risk repeating it.
      if (!isReceiverUnavailableError(error)) throw error;
    }
  }

  throw lastError || new Error(`Runtime message failed: ${message.type}`);
}
