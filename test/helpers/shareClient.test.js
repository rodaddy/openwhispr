const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { createShareClient, shareClientFromEnv } = require("../../src/helpers/shareClient");

const TOKEN = "super-secret-bearer-token";

/** Requests the fake server saw, newest last. */
const requests = [];
/** Set per test: (request, response) => void; receives an already-parsed body. */
let route = null;

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      body: raw.length > 0 ? JSON.parse(raw) : undefined,
    });
    route(request, response, requests[requests.length - 1]);
  });
});

let baseUrl;

/** assert.rejects does not hand back the error, and every case here inspects it. */
async function rejects(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected the call to reject");
}

test.before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => {
  requests.length = 0;
  route = (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ token: "tok", url: "https://share.example/n/tok" }));
  };
});

const client = (overrides = {}) =>
  createShareClient({ baseUrl: `${baseUrl}/`, token: TOKEN, ...overrides });

test("create sends the bearer, path, and a JSON body with a string note_id", async () => {
  route = (_request, response) => {
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ token: "abc", url: "https://share.example/n/abc" }));
  };

  const result = await client().create({ noteId: 42, title: "Note", markdown: "# hi" });

  assert.deepEqual(result, { token: "abc", url: "https://share.example/n/abc" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/api/shares");
  assert.equal(requests[0].authorization, `Bearer ${TOKEN}`);
  assert.match(requests[0].contentType, /application\/json/);
  assert.deepEqual(requests[0].body, { note_id: "42", title: "Note", markdown: "# hi" });
});

test("a trailing slash on baseUrl is stripped exactly once", () => {
  assert.equal(
    createShareClient({ baseUrl: "https://s.example/", token: TOKEN }).baseUrl,
    "https://s.example"
  );
});

test("update PUTs the title and markdown to the token path", async () => {
  const result = await client().update("abc", { title: "New", markdown: "body" });

  assert.deepEqual(result, { token: "tok", url: "https://share.example/n/tok" });
  assert.equal(requests[0].method, "PUT");
  assert.equal(requests[0].url, "/api/shares/abc");
  assert.deepEqual(requests[0].body, { title: "New", markdown: "body" });
});

test("rotate POSTs to the rotate path with no body", async () => {
  const result = await client().rotate("abc");

  assert.equal(result.token, "tok");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/api/shares/abc/rotate");
  assert.equal(requests[0].body, undefined);
  assert.equal(requests[0].contentType, undefined);
});

test("revoke treats 204 as ok", async () => {
  route = (_request, response) => {
    response.writeHead(204);
    response.end();
  };

  assert.deepEqual(await client().revoke("abc"), { ok: true });
  assert.equal(requests[0].method, "DELETE");
  assert.equal(requests[0].url, "/api/shares/abc");
});

test("revoke treats 404 as ok, because the share is already gone", async () => {
  route = (_request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not_found" } }));
  };

  assert.deepEqual(await client().revoke("gone"), { ok: true });
});

test("a 401 throws with the status and the service error code", async () => {
  route = (_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "unauthorized" } }));
  };

  const error = await rejects(() => client().rotate("abc"));
  assert.equal(error.status, 401);
  assert.equal(error.code, "unauthorized");
});

test("a non-JSON 500 falls back to http_<status>", async () => {
  route = (_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("gateway sadness");
  };

  const error = await rejects(() => client().rotate("abc"));
  assert.equal(error.status, 500);
  assert.equal(error.code, "http_500");
});

test("an unconfigured client throws share_not_configured and makes no request", async () => {
  const unconfigured = createShareClient({ baseUrl: "", token: TOKEN });

  assert.equal(unconfigured.configured, false);
  const error = await rejects(() => unconfigured.create({ noteId: 1, title: "t", markdown: "m" }));
  assert.equal(error.code, "share_not_configured");
  assert.equal(requests.length, 0);

  const tokenless = createShareClient({ baseUrl, token: "" });
  assert.equal(tokenless.configured, false);
  assert.equal((await rejects(() => tokenless.revoke("abc"))).code, "share_not_configured");
  assert.equal(requests.length, 0);
});

test("a request that never answers aborts with code timeout", async () => {
  route = () => {
    /* never responds */
  };

  const error = await rejects(() => client({ timeoutMs: 50 }).rotate("abc"));
  assert.equal(error.code, "timeout");
  assert.equal(error.status, undefined);
});

test("an unreachable host gives code network", async () => {
  const offline = createShareClient({ baseUrl: "http://127.0.0.1:1", token: TOKEN });

  const error = await rejects(() => offline.rotate("abc"));
  assert.equal(error.code, "network");
});

test("no error message or code carries the bearer token", async () => {
  route = (_request, response) => {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "forbidden" } }));
  };

  const error = await rejects(() => client().rotate("abc"));
  assert.ok(!error.message.includes(TOKEN));
  assert.ok(!String(error.stack).includes(TOKEN));
});

test("shareClientFromEnv reads the env at call time", () => {
  const configured = shareClientFromEnv({
    SHARE_SERVICE_URL: "https://share.rtech-consulting.com/",
    SHARE_SERVICE_TOKEN: TOKEN,
  });
  assert.equal(configured.configured, true);
  assert.equal(configured.baseUrl, "https://share.rtech-consulting.com");

  assert.equal(shareClientFromEnv({}).configured, false);
});
