import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import type { Config } from "./config.ts";
import type { SessionRepository, VoiceSession } from "./store.ts";

export type RoomService = Pick<RoomServiceClient, "createRoom" | "deleteRoom" | "listRooms">;
type TokenResult = { token: string; participantIdentity: string; expiresAt: number };
type TokenIssuer = (
  session: VoiceSession,
  config: Config,
  now: () => number
) => Promise<TokenResult>;
type Dependencies = Readonly<{
  config: Config;
  store: SessionRepository;
  rooms?: RoomService;
  now?: () => number;
  issueToken?: TokenIssuer;
}>;

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
};
const fail = (response: ServerResponse, status: number, code: string, message: string): void =>
  json(response, status, { error: { code, message } });
const peerIp = (request: IncomingMessage): string =>
  (request.socket.remoteAddress ?? "").replace(/^::ffff:/, "");

function authenticate(request: IncomingMessage, config: Config): string | undefined {
  if (!config.trustedProxyIps.has(peerIp(request))) return undefined;
  const raw = request.headers[config.identityHeader];
  const principal = Array.isArray(raw) ? "" : (raw?.trim() ?? "");
  if (!principal || principal.length > 200 || /[\u0000-\u001f\u007f]/.test(principal))
    return undefined;
  return principal;
}

function checkOrigin(request: IncomingMessage, config: Config): boolean {
  return request.headers.origin === config.publicOrigin;
}

const opaque = (prefix: string): string => `${prefix}_${randomBytes(18).toString("base64url")}`;

async function tokenFor(
  session: VoiceSession,
  config: Config,
  now: () => number
): Promise<{ token: string; participantIdentity: string; expiresAt: number }> {
  const participantIdentity = opaque("participant");
  const nowSeconds = Math.floor(now() / 1000);
  const remainingSeconds = session.expiresAt - nowSeconds;
  if (remainingSeconds <= 0) throw new Error("session expired");
  const access = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity: participantIdentity,
    ttl: remainingSeconds,
  });
  access.addGrant({
    roomJoin: true,
    room: session.room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return { token: await access.toJwt(), participantIdentity, expiresAt: session.expiresAt };
}

/** LiveKit already dropped the room: its TwirpError carries code "not_found" or status 404. */
function isRoomNotFound(error: unknown): boolean {
  const candidate = error as { code?: unknown; status?: unknown } | null;
  return candidate?.code === "not_found" || candidate?.status === 404;
}

export async function reapExpiredSessions(
  store: SessionRepository,
  rooms: RoomService,
  now: () => number = Date.now
): Promise<{ closed: number; pending: number }> {
  let closed = 0;
  let pending = 0;
  for (const session of store.listExpiredOpen(Math.floor(now() / 1000))) {
    try {
      await rooms.deleteRoom(session.room);
      store.close(session.id);
      closed += 1;
    } catch {
      pending += 1;
    }
  }
  return { closed, pending };
}

export function createVoiceServer({
  config,
  store,
  rooms = new RoomServiceClient(
    config.livekitInternalUrl,
    config.livekitApiKey,
    config.livekitApiSecret
  ),
  now = Date.now,
  issueToken = tokenFor,
}: Dependencies) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://local");
    if (request.method === "GET" && url.pathname === "/healthz")
      return json(response, 200, { status: "ok" });
    if (request.method === "GET" && url.pathname === "/readyz") {
      try {
        await rooms.listRooms([]);
        return json(response, 200, { status: "ready" });
      } catch {
        return fail(response, 503, "not_ready", "LiveKit is unavailable");
      }
    }
    if (request.method === "GET" && url.pathname === "/api/config")
      return json(response, 200, { livekitUrl: config.livekitUrl });
    const mutation = request.method === "POST" || request.method === "DELETE";
    if (mutation && !checkOrigin(request, config))
      return fail(response, 403, "invalid_origin", "Origin is not allowed");
    const principal = authenticate(request, config);
    if (url.pathname.startsWith("/api/") && !principal)
      return fail(response, 401, "unauthorized", "Trusted authentication is required");
    try {
      if (request.method === "POST" && url.pathname === "/api/sessions") {
        const issued = Math.floor(now() / 1000);
        const session: VoiceSession = {
          id: randomUUID(),
          owner: principal!,
          room: opaque("room"),
          status: "open",
          createdAt: issued,
          expiresAt: issued + config.sessionTtlSeconds,
        };
        store.create(session);
        let roomRequested = false;
        try {
          const credentials = await issueToken(session, config, now);
          roomRequested = true;
          await rooms.createRoom({
            name: session.room,
            emptyTimeout: config.sessionTtlSeconds,
            maxParticipants: 8,
          });
          return json(response, 201, {
            sessionId: session.id,
            roomName: session.room,
            livekitUrl: config.livekitUrl,
            ...credentials,
          });
        } catch (error) {
          if (!roomRequested) store.close(session.id);
          if (roomRequested) {
            const compensated = await rooms.deleteRoom(session.room).then(
              () => true,
              () => false
            );
            if (compensated) store.close(session.id);
          }
          throw error;
        }
      }
      const match = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)(\/token)?$/);
      if (match) {
        const session = store.find(match[1]);
        if (!session) return fail(response, 404, "not_found", "Session was not found");
        if (session.owner !== principal)
          return fail(response, 403, "forbidden", "Session belongs to another user");
        if (session.status !== "open")
          return fail(response, 409, "session_closed", "Session is closed");
        if (request.method === "POST" && match[2] && session.expiresAt <= Math.floor(now() / 1000))
          return fail(response, 409, "session_closed", "Session is expired");
        if (request.method === "POST" && match[2])
          return json(response, 200, {
            sessionId: session.id,
            roomName: session.room,
            livekitUrl: config.livekitUrl,
            ...(await issueToken(session, config, now)),
          });
        if (request.method === "DELETE" && !match[2]) {
          try {
            await rooms.deleteRoom(session.room);
          } catch (error) {
            if (!isRoomNotFound(error)) throw error;
          }
          store.close(session.id);
          response.writeHead(204);
          return response.end();
        }
      }
      return fail(response, 404, "not_found", "Route was not found");
    } catch {
      return fail(response, 502, "upstream_failure", "Realtime service request failed");
    }
  });
}
