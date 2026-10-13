const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const { artifactDirsToDrop } = require("../../scripts/prune-releases");

const SCRIPT = path.join(__dirname, "..", "..", "scripts", "prune-releases.js");
const REPO = "rtech/rtech-whisper";

const LIVE = [
  { id: 124, tag_name: "v2.0.24", created_at: "2026-10-07T17:04:24-04:00" },
  { id: 123, tag_name: "v2.0.23", created_at: "2026-10-07T16:18:13-04:00" },
  { id: 122, tag_name: "v2.0.22", created_at: "2026-10-07T14:05:11-04:00" },
  { id: 121, tag_name: "v2.0.21", created_at: "2026-10-07T09:58:22-04:00" },
  { id: 120, tag_name: "v2.0.20", created_at: "2026-10-02T20:01:11-04:00" },
  { id: 119, tag_name: "v2.0.19", created_at: "2026-10-01T20:06:37-04:00" },
  { id: 118, tag_name: "v2.0.18", created_at: "2026-10-01T17:12:31-04:00" },
  { id: 117, tag_name: "v2.0.17", created_at: "2026-09-30T21:11:32-04:00" },
  { id: 116, tag_name: "v2.0.16", created_at: "2026-09-30T19:58:06-04:00" },
  { id: 15, tag_name: "v1.10.1-rtech.5", created_at: "2026-09-16T16:37:59-04:00" },
];

const KEEP = ["v2.0.24", "v2.0.20", "v2.0.19"];
const DROPPED_IDS = [15, 116, 117, 118, 121, 122, 123];

test("artifactDirsToDrop keeps the dir of a kept version tag", () => {
  assert.deepEqual(artifactDirsToDrop(["v2.0.24"], KEEP, "v2.0.24"), []);
});

test("artifactDirsToDrop drops the dir of a dropped version tag", () => {
  assert.deepEqual(artifactDirsToDrop(["v2.0.21", "v2.0.20"], KEEP, "v2.0.24"), ["v2.0.21"]);
});

test("artifactDirsToDrop drops a branch build dir", () => {
  assert.deepEqual(artifactDirsToDrop(["feat-x", "v2.0.24"], KEEP, "v2.0.24"), ["feat-x"]);
});

test("artifactDirsToDrop keeps the dir of the current branch build", () => {
  assert.deepEqual(artifactDirsToDrop(["feat-x", "feat-y"], KEEP, "feat/x"), ["feat-y"]);
});

function startFakeForge({ listStatus = 200 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const url = new URL(req.url, "http://localhost");
    const base = `/api/v1/repos/${REPO}/releases`;
    if (req.method === "GET" && url.pathname === base) {
      if (listStatus !== 200) {
        res.writeHead(listStatus).end("boom");
        return;
      }
      const page = Number(url.searchParams.get("page"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(page === 1 ? LIVE : []));
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith(`${base}/`)) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function runCli(serverUrl, args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, "--repo", REPO, ...args],
      { env: { ...process.env, RELEASE_TOKEN: "test-token", GITHUB_SERVER_URL: serverUrl } },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })
    );
  });
}

function makeArtifacts() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prune-releases-test-"));
  for (const name of ["v2.0.24", "v2.0.20", "v2.0.21", "feat-x"]) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, "app.dmg"), "dmg");
  }
  return root;
}

function deletedIds(requests) {
  return requests
    .filter((r) => r.method === "DELETE")
    .map((r) => Number(r.url.split("/").pop()))
    .sort((a, b) => a - b);
}

test("dry run sends no DELETE and removes no dir", async (t) => {
  const forge = await startFakeForge();
  t.after(() => forge.server.close());
  const root = makeArtifacts();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await runCli(forge.url, ["--current", "v2.0.24", "--artifacts", root]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(deletedIds(forge.requests), []);
  assert.match(result.stdout, /^keep v2\.0\.24$/m);
  assert.match(result.stdout, /^drop v2\.0\.21 release 121$/m);
  assert.ok(result.stdout.split("\n").includes(`drop-dir ${path.join(root, "feat-x")}`));
  assert.deepEqual(fs.readdirSync(root).sort(), ["feat-x", "v2.0.20", "v2.0.21", "v2.0.24"]);
  assert.ok(forge.requests.every((r) => r.auth === "token test-token"));
});

test("--apply deletes the dropped releases and dirs only", async (t) => {
  const forge = await startFakeForge();
  t.after(() => forge.server.close());
  const root = makeArtifacts();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await runCli(forge.url, ["--current", "v2.0.24", "--artifacts", root, "--apply"]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(deletedIds(forge.requests), DROPPED_IDS);
  assert.deepEqual(fs.readdirSync(root).sort(), ["v2.0.20", "v2.0.24"]);
});

test("a listing error deletes nothing and exits 1", async (t) => {
  const forge = await startFakeForge({ listStatus: 500 });
  t.after(() => forge.server.close());
  const root = makeArtifacts();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await runCli(forge.url, ["--current", "v2.0.24", "--artifacts", root, "--apply"]);

  assert.equal(result.code, 1);
  assert.deepEqual(deletedIds(forge.requests), []);
  assert.deepEqual(fs.readdirSync(root).sort(), ["feat-x", "v2.0.20", "v2.0.21", "v2.0.24"]);
});
