// Renderer side of the calendar's grill:start (src/helpers/grillStartChannel.js).
// Main drops a subscription when the page reloads, so the caller subscribes on
// every mount; each call here is one fresh subscription.
import type { GrillSessionRequest } from "./grillSession";

interface GrillStartPayload {
  kind?: unknown;
  chapter?: unknown;
  eventId?: unknown;
}

export interface GrillStartApi {
  onGrillStart?: (callback: (request: GrillStartPayload) => void) => () => void;
}

export interface GrillStartLog {
  warn: (message: string, meta?: Record<string, unknown>, scope?: string) => unknown;
}

export function toGrillSessionRequest(payload: unknown): GrillSessionRequest | null {
  if (!payload || typeof payload !== "object") return null;
  const { kind, chapter } = payload as GrillStartPayload;
  if (kind === "daily") return { kind: "daily" };
  if (kind === "lifetime" && typeof chapter === "number" && Number.isInteger(chapter)) {
    return { kind: "lifetime", chapter };
  }
  return null;
}

export function subscribeToGrillStart(
  api: GrillStartApi | null | undefined,
  onStart: (request: GrillSessionRequest) => void,
  log: GrillStartLog
): () => void {
  const unsubscribe = api?.onGrillStart?.((payload) => {
    const request = toGrillSessionRequest(payload);
    if (!request) {
      log.warn("grill:start ignored: malformed request", { payload }, "grill");
      return;
    }
    onStart(request);
  });
  return () => unsubscribe?.();
}

/**
 * A calendar grill:start while a grill is running (or starting) is ignored
 * with a toast; it never cancels the interviewer's stream or the grill.
 */
export function routeCalendarGrillStart(
  request: GrillSessionRequest,
  {
    running,
    start,
    alreadyRunning,
  }: {
    running: boolean;
    start: (request: GrillSessionRequest) => unknown;
    alreadyRunning: () => void;
  }
): void {
  if (running) alreadyRunning();
  else void start(request);
}

/**
 * ChatView's wiring: a grill counts as running while a session is active or
 * a start is still in flight (reading day context).
 */
export function routeChatGrillStart(
  request: GrillSessionRequest,
  grill: { session: unknown; isStarting: boolean },
  handlers: {
    start: (request: GrillSessionRequest) => unknown;
    alreadyRunning: () => void;
  }
): void {
  routeCalendarGrillStart(request, {
    running: Boolean(grill.session) || grill.isStarting,
    ...handlers,
  });
}
