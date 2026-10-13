import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createShareServer } from "../src/app.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { ShareStore } from "../src/store.ts";

const BEARER = "share-service-test-bearer-value-0123456789";
const testDir = fileURLToPath(new URL(".", import.meta.url));
const workDir = mkdtempSync(join(testDir, "run-"));

const config: Config = {
  port: 0,
  dbPath: join(workDir, "share.sqlite"),
  bearer: BEARER,
  publicBase: "https://share.example.test",
};
const store = new ShareStore(config.dbPath);
const server = createShareServer({ config, store });
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

const api = (path: string, method: string, body?: unknown, bearer: string | null = BEARER) =>
  fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

const createShare = async (noteId: string, title: string, markdown: string) => {
  const response = await api("/api/shares", "POST", { note_id: noteId, title, markdown });
  assert.equal(response.status, 201);
  return (await response.json()) as { token: string; url: string };
};

test("healthz answers ok", async () => {
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("app routes require the bearer token", async () => {
  const anonymous = await api(
    "/api/shares",
    "POST",
    { note_id: "n", title: "t", markdown: "" },
    null
  );
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: { code: "unauthorized" } });
  const wrong = await api(
    "/api/shares",
    "POST",
    { note_id: "n", title: "t", markdown: "" },
    "wrong-bearer-value-with-enough-length-000"
  );
  assert.equal(wrong.status, 401);
});

test("create returns a url on the public base", async () => {
  const created = await createShare("note-url", "Title", "body");
  assert.equal(created.url, `https://share.example.test/n/${created.token}`);
});

test("a second create for the same note keeps the token and updates content", async () => {
  const first = await createShare("note-same", "First", "one");
  const second = await createShare("note-same", "Second", "two");
  assert.equal(second.token, first.token);
  const page = await (await fetch(`${base}/n/${first.token}`)).text();
  assert.match(page, /Second/);
  assert.match(page, /two/);
  assert.doesNotMatch(page, /one<\/p>/);
});

test("the page renders markdown with noindex and CSP", async () => {
  const created = await createShare("note-render", "Rendered", "# Heading\n\n- one\n- two\n");
  const response = await fetch(`${base}/n/${created.token}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex");
  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:"
  );
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const page = await response.text();
  assert.match(page, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(page, /<h1>Rendered<\/h1>/);
  assert.match(page, /<h1>Heading<\/h1>/);
  assert.match(page, /<li>one<\/li>/);
  assert.match(page, /Shared from rTech Whisper/);
});

test("raw html in markdown comes out escaped", async () => {
  const created = await createShare(
    "note-script",
    "<script>bad()</script>",
    "<script>alert(1)</script>\n"
  );
  const page = await (await fetch(`${base}/n/${created.token}`)).text();
  assert.doesNotMatch(page, /<script>/);
  assert.match(page, /&lt;script&gt;/);
});

test("a javascript: link is not rendered as an href", async () => {
  const created = await createShare("note-link", "Link", "[x](javascript:alert(1))\n");
  const page = await (await fetch(`${base}/n/${created.token}`)).text();
  assert.doesNotMatch(page, /href="javascript:/i);
});

test("update changes the page", async () => {
  const created = await createShare("note-update", "Before", "before");
  const updated = await api(`/api/shares/${created.token}`, "PUT", {
    title: "After",
    markdown: "after",
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { token: created.token, url: created.url });
  const page = await (await fetch(`${base}/n/${created.token}`)).text();
  assert.match(page, /After/);
  assert.match(page, /<p>after<\/p>/);
});

test("update and delete on an unknown token are 404", async () => {
  const missing = await api("/api/shares/unknown-token", "PUT", { title: "t", markdown: "" });
  assert.equal(missing.status, 404);
  assert.equal((await api("/api/shares/unknown-token", "DELETE")).status, 404);
});

test("rotate invalidates the old link and serves the new one", async () => {
  const created = await createShare("note-rotate", "Rotate", "body");
  const response = await api(`/api/shares/${created.token}/rotate`, "POST");
  assert.equal(response.status, 200);
  const rotated = (await response.json()) as { token: string; url: string };
  assert.notEqual(rotated.token, created.token);
  assert.equal(rotated.url, `https://share.example.test/n/${rotated.token}`);
  assert.equal((await fetch(`${base}/n/${created.token}`)).status, 404);
  assert.equal((await fetch(`${base}/n/${rotated.token}`)).status, 200);
  assert.equal((await api("/api/shares/unknown-token/rotate", "POST")).status, 404);
});

test("delete revokes the link", async () => {
  const created = await createShare("note-delete", "Delete", "body");
  assert.equal((await api(`/api/shares/${created.token}`, "DELETE")).status, 204);
  const gone = await fetch(`${base}/n/${created.token}`);
  assert.equal(gone.status, 404);
  assert.match(await gone.text(), /This link is not available\./);
});

test("a body over 1 MB is rejected", async () => {
  const big = JSON.stringify({
    note_id: "note-big",
    title: "Big",
    markdown: "x".repeat(1_100_000),
  });
  const response = await api("/api/shares", "POST", big);
  assert.equal(response.status, 413);
});

test("a missing title is a 400", async () => {
  const response = await api("/api/shares", "POST", { note_id: "note-400", markdown: "body" });
  assert.equal(response.status, 400);
  const emptyMarkdown = await api("/api/shares", "POST", {
    note_id: "note-empty-md",
    title: "Empty",
    markdown: "",
  });
  assert.equal(emptyMarkdown.status, 201);
});

test("config without SHARE_BEARER throws naming the variable", () => {
  assert.throws(() => loadConfig({ SHARE_DB_PATH: "x" } as NodeJS.ProcessEnv), /SHARE_BEARER/);
  assert.throws(
    () => loadConfig({ SHARE_DB_PATH: "x", SHARE_BEARER: "short" } as NodeJS.ProcessEnv),
    /SHARE_BEARER/
  );
  assert.throws(() => loadConfig({ SHARE_BEARER: BEARER } as NodeJS.ProcessEnv), /SHARE_DB_PATH/);
});
