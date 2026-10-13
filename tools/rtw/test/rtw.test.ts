// End-to-end tests for the rtw CLI and MCP server against a FAKE bridge: a
// node:http server on port 0 that speaks the same envelope as
// src/helpers/cliBridge.js. The real app is never started and the real bridge
// file is never read — RTW_BRIDGE_FILE points every child at a temp directory
// this file creates under test/ and removes in `after`.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const RTW = join(PKG, "bin", "rtw");
const TOKEN = "f".repeat(64);

const EXPECTED_TOOLS = [
  "folders_list",
  "note_create",
  "note_get",
  "note_update",
  "notes_list",
  "notes_search",
  "transcriptions_list",
];

interface Note {
  id: number;
  title: string;
  content: string;
  note_type: string;
  folder_id: number | null;
}

let server: Server;
let tmpDir: string;
let bridgeFile: string;
let notes: Note[];
let nextId: number;

function json(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function resetFixtures() {
  notes = [
    {
      id: 1,
      title: "Bridge fixture note",
      content: "the quick brown fox dictated a memo",
      note_type: "personal",
      folder_id: null,
    },
  ];
  nextId = 2;
}

function startFakeBridge(): Promise<Server> {
  const s = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return json(res, 401, { error: { code: "unauthorized", message: "Unauthorized" } });
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : {};
      const path = url.pathname;

      if (req.method === "GET" && path === "/v1/health") {
        return json(res, 200, { data: { ok: true, version: 1 } });
      }
      if (req.method === "GET" && path === "/v1/notes/list") {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        return json(res, 200, {
          data: notes.slice(0, limit),
          has_more: false,
          next_cursor: null,
        });
      }
      if (req.method === "GET" && path === "/v1/notes/search") {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (!q) {
          return json(res, 400, {
            error: { code: "validation_error", message: "Search query is required" },
          });
        }
        const needle = q.toLowerCase();
        const hits = notes.filter(
          (n) => n.title.toLowerCase().includes(needle) || n.content.toLowerCase().includes(needle)
        );
        return json(res, 200, { data: hits, has_more: false, next_cursor: null });
      }
      if (req.method === "GET" && path === "/v1/folders/list") {
        return json(res, 200, {
          data: [{ id: 7, name: "Inbox" }],
          has_more: false,
          next_cursor: null,
        });
      }
      if (req.method === "GET" && path === "/v1/transcriptions/list") {
        return json(res, 200, {
          data: [{ id: 3, text: "hello from the fake bridge" }],
          has_more: false,
          next_cursor: null,
        });
      }
      if (req.method === "POST" && path === "/v1/notes/create") {
        const note: Note = {
          id: nextId++,
          title: body.title ?? "Untitled Note",
          content: body.content ?? "",
          note_type: body.note_type ?? "personal",
          folder_id: body.folder_id ?? null,
        };
        notes.push(note);
        return json(res, 201, { data: note });
      }
      const noteMatch = /^\/v1\/notes\/(\d+)$/.exec(path);
      if (noteMatch) {
        const id = Number(noteMatch[1]);
        const note = notes.find((n) => n.id === id);
        if (!note) {
          return json(res, 404, {
            error: { code: "not_found", message: `Note ${id} not found` },
          });
        }
        if (req.method === "GET") return json(res, 200, { data: note });
        if (req.method === "PATCH") {
          if (body.title !== undefined) note.title = body.title;
          if (body.content !== undefined) note.content = body.content;
          return json(res, 200, { data: note });
        }
      }
      return json(res, 404, { error: { code: "not_found", message: "Not found" } });
    });
  });
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(s)));
}

function writeBridgeFile(file: string, token: string) {
  const port = (server.address() as { port: number }).port;
  writeFileSync(file, JSON.stringify({ version: 1, port, token }), { mode: 0o600 });
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function rtw(args: string[], bridge = bridgeFile): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(RTW, args, {
      env: { ...process.env, RTW_BRIDGE_FILE: bridge },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

before(async () => {
  server = await startFakeBridge();
  tmpDir = mkdtempSync(join(HERE, "tmp-"));
  bridgeFile = join(tmpDir, "cli-bridge.json");
  resetFixtures();
  writeBridgeFile(bridgeFile, TOKEN);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("rtw CLI", () => {
  it("reports health from the bridge", async () => {
    const run = await rtw(["health"]);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { ok: true, version: 1 });
  });

  it("prints usage for --help and exits 0", async () => {
    const run = await rtw(["--help"]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /rtw notes search <query>/);
  });

  it("exits 64 on an unknown command", async () => {
    const run = await rtw(["frobnicate"]);
    assert.equal(run.code, 64);
    assert.match(run.stderr, /unknown command: frobnicate/);
  });

  it("searches notes and returns the fixture", async () => {
    const run = await rtw(["notes", "search", "brown fox"]);
    assert.equal(run.code, 0, run.stderr);
    const hits = JSON.parse(run.stdout);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, "Bridge fixture note");
  });

  it("lists folders and transcriptions", async () => {
    const folders = await rtw(["folders", "list"]);
    assert.equal(folders.code, 0, folders.stderr);
    assert.equal(JSON.parse(folders.stdout)[0].name, "Inbox");

    const transcriptions = await rtw(["transcriptions", "list", "--limit", "5"]);
    assert.equal(transcriptions.code, 0, transcriptions.stderr);
    assert.equal(JSON.parse(transcriptions.stdout)[0].id, 3);
  });

  it("round-trips create then get", async () => {
    const created = await rtw([
      "notes",
      "create",
      "--title",
      "Created by test",
      "--content",
      "body text",
    ]);
    assert.equal(created.code, 0, created.stderr);
    const note = JSON.parse(created.stdout);
    assert.equal(note.title, "Created by test");

    const fetched = await rtw(["notes", "get", String(note.id)]);
    assert.equal(fetched.code, 0, fetched.stderr);
    assert.deepEqual(JSON.parse(fetched.stdout), note);
  });

  it("updates a note's title", async () => {
    const run = await rtw(["notes", "update", "1", "--title", "Renamed"]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).title, "Renamed");
  });

  it("exits 2 with the bridge code when the token is wrong", async () => {
    const badFile = join(tmpDir, "bad-token.json");
    writeBridgeFile(badFile, "0".repeat(64));
    const run = await rtw(["health"], badFile);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /unauthorized/);
  });

  it("exits 2 with 'not running' when the bridge file is missing", async () => {
    const run = await rtw(["health"], join(tmpDir, "absent.json"));
    assert.equal(run.code, 2);
    assert.match(run.stderr, /is not running \(no bridge file at/);
    assert.doesNotMatch(run.stderr, new RegExp(TOKEN));
  });
});

describe("rtw mcp", () => {
  it("exposes exactly the 7 tools and serves notes_search", async () => {
    const transport = new StdioClientTransport({
      command: RTW,
      args: ["mcp"],
      env: { ...process.env, RTW_BRIDGE_FILE: bridgeFile } as Record<string, string>,
    });
    const client = new Client({ name: "rtw-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);

      const result = await client.callTool({
        name: "notes_search",
        arguments: { query: "brown fox" },
      });
      assert.notEqual(result.isError, true);
      const text = (result.content as { type: string; text: string }[])[0].text;
      const hits = JSON.parse(text);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].content, "the quick brown fox dictated a memo");
    } finally {
      await client.close();
    }
  });
});
