// Client-side runtime messaging for extension surfaces (popup, options,
// content script). The retry variant exists because sendMessage can fail
// briefly while the MV3 service worker is still waking up (its onMessage
// listener isn't registered yet). Crucially it retries ONLY that
// missing-receiver failure — where the message provably never ran — so it is
// safe for non-idempotent gestures (jump, open-in-new-tab): any other failure
// may mean the worker DID process the message but the reply was lost, and
// re-sending would double-execute the action, so those surface immediately.

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
