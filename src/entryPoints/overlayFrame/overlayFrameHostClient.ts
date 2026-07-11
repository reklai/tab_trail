// Frame→host RPC binder and SavedTrailsClient adapter over the MessagePort.

import type { SavedTrailsClient } from "../../lib/adapters/runtime/savedTrailsClient";
import type {
  DeleteSavedTrailResult,
  ReplaceSavedTrailResult,
  SaveNamedTrailResult,
  SavedTrailMutationResult,
} from "../../lib/adapters/storage/savedTrailsStore";
import {
  OVERLAY_FRAME_PROTOCOL_VERSION,
  type OverlayFrameToHostMessage,
  type OverlayRpcMethod,
  type OverlayRpcParamsMap,
  type OverlayRpcRequest,
  type OverlayRpcResultMap,
} from "../../lib/common/contracts/overlayFrame";

const RPC_TIMEOUT_MS = 15000;

interface PendingRpc {
  method: OverlayRpcMethod;
  timeout: number;
  resolve: (result: unknown) => void;
  reject: (reason: Error) => void;
}

export interface OverlayFrameHostClient {
  requestHost: <M extends OverlayRpcMethod>(
    method: M,
    params: OverlayRpcParamsMap[M],
  ) => Promise<OverlayRpcResultMap[M]>;
  savedTrailsClient: SavedTrailsClient;
  rejectPending(reason: string): void;
  resolveRpcResponse(
    requestId: number,
    method: OverlayRpcMethod,
    result: unknown,
  ): "ok" | "missing" | "method-mismatch";
  notifySavedTrails(trails: SavedTrail[]): void;
  clearSavedTrailSubscribers(): void;
}

export function createOverlayFrameHostClient(deps: {
  postToHost: (message: OverlayFrameToHostMessage) => void;
  isActive: () => boolean;
}): OverlayFrameHostClient {
  let nextRequestId = 0;
  const pendingRpcs = new Map<number, PendingRpc>();
  const savedTrailSubscribers = new Set<(trails: SavedTrail[]) => void>();

  function rejectPending(reason: string): void {
    for (const pending of pendingRpcs.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    pendingRpcs.clear();
  }

  function requestHost<M extends OverlayRpcMethod>(
    method: M,
    params: OverlayRpcParamsMap[M],
  ): Promise<OverlayRpcResultMap[M]> {
    if (!deps.isActive()) return Promise.reject(new Error("Overlay host disconnected"));
    const requestId = ++nextRequestId;
    const request = { requestId, method, params } as OverlayRpcRequest<M>;
    return new Promise<OverlayRpcResultMap[M]>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRpcs.delete(requestId);
        reject(new Error("Overlay request timed out"));
      }, RPC_TIMEOUT_MS);
      pendingRpcs.set(requestId, {
        method,
        timeout,
        resolve: resolve as (result: unknown) => void,
        reject,
      });
      deps.postToHost({
        type: "FRAME_RPC_REQUEST",
        version: OVERLAY_FRAME_PROTOCOL_VERSION,
        request: request as unknown as OverlayRpcRequest,
      });
    });
  }

  function savedFailureReason(result: { ok: false; reason?: string }, fallback: string): string {
    return result.reason || fallback;
  }

  function asSavedMutationResult(
    result: OverlayRpcResultMap["SAVED_SAVE"],
    fallback: string,
  ): SavedTrailMutationResult {
    return result.ok
      ? result
      : { ok: false, reason: savedFailureReason(result, fallback) };
  }

  const savedTrailsClient: SavedTrailsClient = {
    load: async () => {
      const result = await requestHost("SAVED_LOAD", {});
      if (result.ok) return result.trails;
      throw new Error(savedFailureReason(result, "Could not load saved trails"));
    },
    subscribe: (onChanged) => {
      // Host pushes HOST_SAVED_TRAILS_UPDATED for the whole overlay session.
      savedTrailSubscribers.add(onChanged);
      return () => {
        savedTrailSubscribers.delete(onChanged);
      };
    },
    open: (path, mode) => requestHost("SAVED_OPEN", { path, mode }),
    save: async (path, name): Promise<SaveNamedTrailResult> => asSavedMutationResult(
      await requestHost("SAVED_SAVE", { path, name }),
      "Could not save trail",
    ),
    rename: async (id, name): Promise<SavedTrailMutationResult> => asSavedMutationResult(
      await requestHost("SAVED_RENAME", { id, name }),
      "Could not rename trail",
    ),
    replace: async (id, path, expectedPath): Promise<ReplaceSavedTrailResult> => {
      const result = await requestHost("SAVED_REPLACE", { id, path, expectedPath });
      return result.ok
        ? result
        : { ok: false, reason: savedFailureReason(result, "Could not update trail") };
    },
    setPinned: async (id, pinned): Promise<SavedTrailMutationResult> => asSavedMutationResult(
      await requestHost("SAVED_SET_PINNED", { id, pinned }),
      "Could not change pinned state",
    ),
    delete: async (id): Promise<DeleteSavedTrailResult> => asSavedMutationResult(
      await requestHost("SAVED_DELETE", { id }),
      "Could not remove trail",
    ),
    restore: async (trail): Promise<SavedTrailMutationResult> => asSavedMutationResult(
      await requestHost("SAVED_RESTORE", { trail }),
      "Could not restore trail",
    ),
  };

  function resolveRpcResponse(
    requestId: number,
    method: OverlayRpcMethod,
    result: unknown,
  ): "ok" | "missing" | "method-mismatch" {
    const pending = pendingRpcs.get(requestId);
    if (!pending) return "missing";
    if (pending.method !== method) return "method-mismatch";
    pendingRpcs.delete(requestId);
    window.clearTimeout(pending.timeout);
    pending.resolve(result);
    return "ok";
  }

  function notifySavedTrails(trails: SavedTrail[]): void {
    for (const subscriber of savedTrailSubscribers) subscriber(trails);
  }

  function clearSavedTrailSubscribers(): void {
    savedTrailSubscribers.clear();
  }

  return {
    requestHost,
    savedTrailsClient,
    rejectPending,
    resolveRpcResponse,
    notifySavedTrails,
    clearSavedTrailSubscribers,
  };
}
