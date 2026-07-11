// Host-side overlay RPC dispatch. Maps wire methods to page/background clients.

import { browserSavedTrailsClient } from "../../adapters/runtime/savedTrailsClient";
import {
  jumpToTrailEntry,
  openTabTrailOptions,
  openTrailEntryInNewTab,
  openTrailEntryInNewWindow,
} from "../../adapters/runtime/tabtrailApi";
import type {
  OverlayRpcMethod,
  OverlayRpcParamsMap,
  OverlayRpcRequest,
  OverlayRpcResponse,
  OverlayRpcResultMap,
} from "../../common/contracts/overlayFrame";
import { actionFailure } from "./overlayFrameSession";

export interface OverlayRpcDeps {
  onPositionChange: (position: TabTrailOverlayPosition) => void | Promise<void>;
}

type RpcHandlerMap = {
  [M in OverlayRpcMethod]: (
    params: OverlayRpcParamsMap[M],
  ) => Promise<OverlayRpcResultMap[M]>;
};

function rpcResponse<M extends OverlayRpcMethod>(
  request: OverlayRpcRequest<M>,
  result: OverlayRpcResultMap[M],
): OverlayRpcResponse {
  return {
    requestId: request.requestId,
    method: request.method,
    result,
  } as OverlayRpcResponse;
}

async function normalizeAction(
  operation: () => Promise<TabTrailActionResult>,
  fallback: string,
): Promise<TabTrailActionResult> {
  try {
    return await operation();
  } catch (_) {
    return actionFailure(fallback);
  }
}

function actionFailureResult(reason: string): OverlayRpcResultMap[OverlayRpcMethod] {
  return actionFailure(reason);
}

export function createOverlayRpcExecutor(
  deps: OverlayRpcDeps,
): (request: OverlayRpcRequest) => Promise<OverlayRpcResponse> {
  const handlers: RpcHandlerMap = {
    LIVE_JUMP: (params) => normalizeAction(
      () => jumpToTrailEntry(params.index),
      "Could not navigate to that trail entry",
    ),
    LIVE_OPEN_NEW_TAB: (params) => normalizeAction(
      () => openTrailEntryInNewTab(params.index),
      "Could not open that entry in a new tab",
    ),
    LIVE_OPEN_NEW_WINDOW: (params) => normalizeAction(
      () => openTrailEntryInNewWindow(params.index),
      "Could not open that entry in a new window",
    ),
    LIVE_OPEN_OPTIONS: () => normalizeAction(openTabTrailOptions, "Settings unavailable"),
    // Sync resolve so LIVE_CLOSE response + hibernate schedule without an extra
    // async-function microtask beyond the outer await.
    LIVE_CLOSE: () => Promise.resolve({ ok: true as const }),
    LIVE_SET_POSITION: async (params) => {
      await deps.onPositionChange(params.position);
      return { ok: true };
    },
    SAVED_LOAD: async () => ({ ok: true, trails: await browserSavedTrailsClient.load() }),
    SAVED_OPEN: (params) => normalizeAction(
      () => browserSavedTrailsClient.open(params.path, params.mode),
      "Could not open saved trail",
    ),
    SAVED_SAVE: (params) => browserSavedTrailsClient.save(params.path, params.name),
    SAVED_RENAME: (params) => browserSavedTrailsClient.rename(params.id, params.name),
    SAVED_REPLACE: (params) => browserSavedTrailsClient.replace(
      params.id,
      params.path,
      params.expectedPath,
    ),
    SAVED_SET_PINNED: (params) => browserSavedTrailsClient.setPinned(params.id, params.pinned),
    SAVED_DELETE: (params) => browserSavedTrailsClient.delete(params.id),
    SAVED_RESTORE: (params) => browserSavedTrailsClient.restore(params.trail),
  };

  const fallbacks: Record<OverlayRpcMethod, string> = {
    LIVE_JUMP: "Could not navigate to that trail entry",
    LIVE_OPEN_NEW_TAB: "Could not open that entry in a new tab",
    LIVE_OPEN_NEW_WINDOW: "Could not open that entry in a new window",
    LIVE_OPEN_OPTIONS: "Settings unavailable",
    LIVE_CLOSE: "Could not close overlay",
    LIVE_SET_POSITION: "Could not save overlay position",
    SAVED_LOAD: "Could not load saved trails",
    SAVED_OPEN: "Could not open saved trail",
    SAVED_SAVE: "Could not save trail",
    SAVED_RENAME: "Could not rename trail",
    SAVED_REPLACE: "Could not update trail",
    SAVED_SET_PINNED: "Could not change pinned state",
    SAVED_DELETE: "Could not remove trail",
    SAVED_RESTORE: "Could not restore trail",
  };

  return async (request: OverlayRpcRequest): Promise<OverlayRpcResponse> => {
    try {
      // Exhaustive map: each method's params/result pair is bound above.
      const handler = handlers[request.method] as (
        params: OverlayRpcParamsMap[typeof request.method],
      ) => Promise<OverlayRpcResultMap[typeof request.method]>;
      const result = await handler(request.params);
      return rpcResponse(request, result);
    } catch (_) {
      return rpcResponse(
        request,
        actionFailureResult(fallbacks[request.method]) as OverlayRpcResultMap[typeof request.method],
      );
    }
  };
}
