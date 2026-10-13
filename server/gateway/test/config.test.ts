import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

const valid = {
  VOICE_DB_PATH: ":memory:",
  VOICE_TRUSTED_PROXY_IPS: "127.0.0.1",
  VOICE_IDENTITY_HEADER: "X-Auth-User",
  VOICE_PUBLIC_ORIGIN: "https://voice.example.test",
  LIVEKIT_URL: "wss://rtc.example.test",
  LIVEKIT_INTERNAL_URL: "http://127.0.0.1:7880",
  LIVEKIT_API_KEY: "key",
  LIVEKIT_API_SECRET: "a-secure-value-that-is-at-least-thirty-two-bytes",
};

test("fails closed on malformed proxy and weak secret configuration", () => {
  assert.throws(() => loadConfig({ ...valid, VOICE_TRUSTED_PROXY_IPS: "10.0.0.0/24" }), /exact IP/);
  assert.throws(() => loadConfig({ ...valid, LIVEKIT_API_SECRET: "example-secret" }), /32 bytes/);
});

test("applies bounded production defaults", () => {
  const config = loadConfig(valid);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8090);
  assert.equal(config.sessionTtlSeconds, 3600);
  assert.equal(config.identityHeader, "x-auth-user");
  assert.throws(() => loadConfig({ ...valid, VOICE_SESSION_TTL_SECONDS: "60" }), /300..86400/);
});

test("serves no retired web recorder: VOICE_WEB_ROOT is ignored", () => {
  const config = loadConfig({ ...valid, VOICE_WEB_ROOT: "/srv/web" });
  assert.equal("webRoot" in config, false);
});
