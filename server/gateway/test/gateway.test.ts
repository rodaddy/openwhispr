import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { mkdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createVoiceServer, reapExpiredSessions, type RoomService } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { SessionStore, type SessionRepository, type VoiceSession } from "../src/store.ts";

const config: Config = {
  host: "127.0.0.1",
  port: 0,
  dbPath: ":memory:",
  trustedProxyIps: new Set(["127.0.0.1"]),
  identityHeader: "x-auth-user",
  publicOrigin: "https://voice.example.test",
  livekitUrl: "wss://rtc.example.test",
  livekitInternalUrl: "http://127.0.0.1:7880",
  livekitApiKey: "test-key",
  livekitApiSecret: "a-secure-test-value-with-at-least-32-bytes",
  sessionTtlSeconds: 3600,
};
const calls = {
  created: [] as string[],
  deleted: [] as string[],
  failDelete: false,
  notFoundDelete: false,
};
const rooms = {
  async createRoom(options: { name: string }) {
    calls.created.push(options.name);
    return {};
  },
  async deleteRoom(name: string) {
    if (calls.notFoundDelete)
      throw Object.assign(new Error("room not found"), { code: "not_found", status: 404 });
    if (calls.failDelete) throw new Error("down");
    calls.deleted.push(name);
  },
  async listRooms() {
    return [];
  },
} as unknown as RoomService;
const store = new SessionStore(":memory:");
let clock = 1_800_000_000_000;
const server = createVoiceServer({ config, store, rooms, now: () => clock });
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.closeDb();
});

const mutate = (path: string, user?: string, method = "POST") =>
  fetch(base + path, {
    method,
    headers: { origin: config.publicOrigin, ...(user ? { "x-auth-user": user } : {}) },
  });

async function withTestServer(
  options: { store: SessionRepository; rooms: RoomService; issueToken?: () => Promise<never> },
  action: (url: string) => Promise<void>
): Promise<void> {
  const testServer = createVoiceServer({ config, ...options, now: () => clock });
  await new Promise<void>((resolve) => testServer.listen(0, "127.0.0.1", resolve));
  try {
    await action(`http://127.0.0.1:${(testServer.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
  }
}

test("rejects missing identity and a forged identity from an untrusted origin", async () => {
  assert.equal((await mutate("/api/sessions")).status, 401);
  const response = await fetch(base + "/api/sessions", {
    method: "POST",
    headers: { origin: "https://evil.test", "x-auth-user": "alice" },
  });
  assert.equal(response.status, 403);
});

test("creates isolated rooms and issues a room-scoped token", async () => {
  const first = await mutate("/api/sessions", "alice");
  const second = await mutate("/api/sessions", "alice");
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const a = (await first.json()) as Record<string, string>;
  const b = (await second.json()) as Record<string, string>;
  assert.notEqual(a.roomName, b.roomName);
  const payload = JSON.parse(Buffer.from(a.token.split(".")[1], "base64url").toString()) as {
    video: Record<string, unknown>;
    sub: string;
    exp: number;
    nbf: number;
  };
  assert.deepEqual(payload.video, {
    roomJoin: true,
    room: a.roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  assert.equal(payload.sub, a.participantIdentity);
  assert.equal(payload.exp - payload.nbf, 3600);
});

test("enforces ownership and refreshes with a unique participant identity", async () => {
  const created = (await (await mutate("/api/sessions", "alice")).json()) as Record<string, string>;
  assert.equal((await mutate(`/api/sessions/${created.sessionId}/token`, "bob")).status, 403);
  const refreshed = (await (
    await mutate(`/api/sessions/${created.sessionId}/token`, "alice")
  ).json()) as Record<string, string>;
  assert.notEqual(refreshed.participantIdentity, created.participantIdentity);
});

test("caps a refreshed token to the persisted session lifetime", async () => {
  clock = 1_800_000_000_000;
  const created = (await (await mutate("/api/sessions", "alice")).json()) as Record<string, string>;
  clock += 3_300_000;
  const refreshed = (await (
    await mutate(`/api/sessions/${created.sessionId}/token`, "alice")
  ).json()) as Record<string, string>;
  const payload = JSON.parse(
    Buffer.from(refreshed.token.split(".")[1], "base64url").toString()
  ) as { exp: number; nbf: number };
  assert.equal(payload.exp - payload.nbf, 300);
  assert.equal(Number(refreshed.expiresAt), 1_800_003_600);
});

test("keeps a session open when LiveKit room deletion fails", async () => {
  const created = (await (await mutate("/api/sessions", "alice")).json()) as Record<string, string>;
  calls.failDelete = true;
  assert.equal((await mutate(`/api/sessions/${created.sessionId}`, "alice", "DELETE")).status, 502);
  calls.failDelete = false;
  assert.equal((await mutate(`/api/sessions/${created.sessionId}/token`, "alice")).status, 200);
});

test("closes the session with 204 when LiveKit already dropped the room", async () => {
  clock = 1_800_000_000_000;
  const created = (await (await mutate("/api/sessions", "alice")).json()) as Record<string, string>;
  calls.notFoundDelete = true;
  assert.equal((await mutate(`/api/sessions/${created.sessionId}`, "alice", "DELETE")).status, 204);
  calls.notFoundDelete = false;
  assert.equal((await mutate(`/api/sessions/${created.sessionId}/token`, "alice")).status, 409);
});

test("keeps the session open on a generic LiveKit deletion error", async () => {
  clock = 1_800_000_000_000;
  const created = (await (await mutate("/api/sessions", "alice")).json()) as Record<string, string>;
  calls.failDelete = true;
  assert.equal((await mutate(`/api/sessions/${created.sessionId}`, "alice", "DELETE")).status, 502);
  calls.failDelete = false;
  assert.equal((await mutate(`/api/sessions/${created.sessionId}/token`, "alice")).status, 200);
});

test("does not request a room when persistence fails", async () => {
  let roomRequests = 0;
  const failedStore = {
    create() {
      throw new Error("db down");
    },
    find() {
      return undefined;
    },
    close() {},
    listExpiredOpen() {
      return [];
    },
  };
  const testRooms = {
    ...rooms,
    async createRoom() {
      roomRequests += 1;
      return {};
    },
  } as unknown as RoomService;
  await withTestServer({ store: failedStore, rooms: testRooms }, async (url) => {
    const response = await fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: { origin: config.publicOrigin, "x-auth-user": "alice" },
    });
    assert.equal(response.status, 502);
  });
  assert.equal(roomRequests, 0);
});

test("closes persisted state when token issuance fails", async () => {
  let persisted: VoiceSession | undefined;
  let closed = false;
  const repository = {
    create(session: VoiceSession) {
      persisted = session;
    },
    find() {
      return persisted;
    },
    close() {
      closed = true;
    },
    listExpiredOpen() {
      return [];
    },
  };
  await withTestServer(
    {
      store: repository,
      rooms,
      issueToken: async () => {
        throw new Error("signing failed");
      },
    },
    async (url) => {
      const response = await fetch(`${url}/api/sessions`, {
        method: "POST",
        headers: { origin: config.publicOrigin, "x-auth-user": "alice" },
      });
      assert.equal(response.status, 502);
    }
  );
  assert.equal(closed, true);
});

test("compensates a partially failed room creation", async () => {
  const deleted: string[] = [];
  let persisted: VoiceSession | undefined;
  let closed = false;
  const repository = {
    create(session: VoiceSession) {
      persisted = session;
    },
    find() {
      return persisted;
    },
    close() {
      closed = true;
    },
    listExpiredOpen() {
      return [];
    },
  };
  const failedRooms = {
    async createRoom() {
      throw new Error("uncertain create");
    },
    async deleteRoom(room: string) {
      deleted.push(room);
    },
    async listRooms() {
      return [];
    },
  } as unknown as RoomService;
  await withTestServer({ store: repository, rooms: failedRooms }, async (url) => {
    const response = await fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: { origin: config.publicOrigin, "x-auth-user": "alice" },
    });
    assert.equal(response.status, 502);
  });
  assert.equal(closed, true);
  assert.deepEqual(deleted, [persisted?.room]);
});

test("retains an uncertain room for expiry retry when compensation fails", async () => {
  let persisted: VoiceSession | undefined;
  let closed = false;
  const repository = {
    create(session: VoiceSession) {
      persisted = session;
    },
    find() {
      return persisted;
    },
    close() {
      closed = true;
    },
    listExpiredOpen() {
      return persisted && !closed ? [persisted] : [];
    },
  };
  let deleteFails = true;
  const uncertainRooms = {
    async createRoom() {
      throw new Error("uncertain create");
    },
    async deleteRoom() {
      if (deleteFails) throw new Error("cleanup down");
    },
    async listRooms() {
      return [];
    },
  } as unknown as RoomService;
  await withTestServer({ store: repository, rooms: uncertainRooms }, async (url) => {
    const response = await fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: { origin: config.publicOrigin, "x-auth-user": "alice" },
    });
    assert.equal(response.status, 502);
  });
  assert.equal(closed, false);
  deleteFails = false;
  assert.deepEqual(await reapExpiredSessions(repository, uncertainRooms, () => 2_000_000_000_000), {
    closed: 1,
    pending: 0,
  });
  assert.equal(closed, true);
});

test("lets an owner delete an expired session", async () => {
  clock = 1_800_000_000_000;
  const created = (await (await mutate("/api/sessions", "alice")).json()) as Record<string, string>;
  clock += 3_601_000;
  assert.equal((await mutate(`/api/sessions/${created.sessionId}`, "alice", "DELETE")).status, 204);
});

test("reaps only persisted expired rooms and retries failures after restart", async () => {
  const tempRoot = `${(await import("node:os")).tmpdir()}/openwhispr-gateway-tests`;
  mkdirSync(tempRoot, { recursive: true });
  const dbPath = `${tempRoot}/${randomUUID()}.sqlite`;
  const initial = new SessionStore(dbPath);
  initial.create({
    id: "expired",
    owner: "alice",
    room: "owned-expired",
    status: "open",
    createdAt: 1,
    expiresAt: 10,
  });
  initial.create({
    id: "future",
    owner: "alice",
    room: "owned-future",
    status: "open",
    createdAt: 1,
    expiresAt: 999,
  });
  initial.closeDb();
  const restarted = new SessionStore(dbPath);
  let fail = true;
  const deleted: string[] = [];
  const retryRooms = {
    async deleteRoom(room: string) {
      deleted.push(room);
      if (fail) throw new Error("down");
    },
    async createRoom() {
      return {};
    },
    async listRooms() {
      return [];
    },
  } as unknown as RoomService;
  assert.deepEqual(await reapExpiredSessions(restarted, retryRooms, () => 100_000), {
    closed: 0,
    pending: 1,
  });
  assert.equal(restarted.find("expired")?.status, "open");
  fail = false;
  assert.deepEqual(await reapExpiredSessions(restarted, retryRooms, () => 100_000), {
    closed: 1,
    pending: 0,
  });
  assert.equal(restarted.find("expired")?.status, "closed");
  assert.equal(restarted.find("future")?.status, "open");
  assert.deepEqual(deleted, ["owned-expired", "owned-expired"]);
  restarted.closeDb();
  unlinkSync(dbPath);
});
