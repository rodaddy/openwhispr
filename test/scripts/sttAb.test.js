const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const load = () =>
  import(pathToFileURL(path.join(__dirname, "../../scripts/stt-ab/scoring.mjs")).href);

test("normalizeText drops case and punctuation, keeps apostrophes, splits hyphens", async () => {
  const { normalizeText } = await load();
  assert.deepEqual(normalizeText("Hello, World! It’s a well-known test."), [
    "hello",
    "world",
    "it's",
    "a",
    "well",
    "known",
    "test",
  ]);
  assert.deepEqual(normalizeText(null), []);
});

test("normalizeText keeps combining marks, so an accent-only difference is an error", async () => {
  const { normalizeText, wer } = await load();
  // Decomposed and precomposed forms of the same word still match.
  assert.equal(wer("caf\u00e9", "cafe\u0301"), 0);
  // Words differing only by an accent or vowel mark are a substitution.
  assert.equal(wer("caf\u00e9", "cafe"), 1);
  assert.equal(wer("x\u0301", "x"), 1);
  assert.equal(wer("\u0915\u093f", "\u0915\u093e"), 1);
  // Marks stay inside the word instead of splitting it.
  assert.deepEqual(normalizeText("\u0915\u093f\u0924\u093e\u092c"), [
    "\u0915\u093f\u0924\u093e\u092c",
  ]);
});

test("normalizeText treats an acute accent or backtick apostrophe as an apostrophe", async () => {
  const { normalizeText, wer } = await load();
  // NFKC splits "´" into a space and a bare U+0301; it must not become a word.
  assert.deepEqual(normalizeText("don´t"), ["don't"]);
  assert.deepEqual(normalizeText("don`t"), ["don't"]);
  // Compatibility forms that NFKC maps onto the same two characters.
  assert.deepEqual(normalizeText("don´t"), ["don't"]);
  assert.deepEqual(normalizeText("don｀t"), ["don't"]);
  assert.equal(wer("don´t stop", "don't stop"), 0);
  assert.deepEqual(normalizeText("a ́ b"), ["a", "b"]);
});

test("wer counts substitutions, deletions and insertions", async () => {
  const { wer, werCounts } = await load();
  assert.equal(wer("the cat sat", "The cat sat."), 0);
  assert.equal(wer("the cat sat", "the dog sat"), 1 / 3);
  assert.equal(wer("the cat sat", "the sat"), 1 / 3);
  assert.equal(wer("the cat sat", "the cat sat down"), 1 / 3);
  assert.deepEqual(werCounts("a b", "c d e"), { errors: 3, refWords: 2 });
  assert.equal(wer("", ""), 0);
  assert.equal(wer("", "noise"), 1);
});

test("bucketFor splits at 3 s and 15 s", async () => {
  const { bucketFor } = await load();
  assert.equal(bucketFor(2999), "under-3s");
  assert.equal(bucketFor(3000), "3-15s");
  assert.equal(bucketFor(15000), "3-15s");
  assert.equal(bucketFor(15001), "over-15s");
  assert.throws(() => bucketFor(NaN), RangeError);
  assert.throws(() => bucketFor(undefined), RangeError);
});

test("stratifiedSample is seed-stable, order-independent and balanced", async () => {
  const { stratifiedSample } = await load();
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push({ id: i, audio_duration_ms: [1000, 8000, 30000][i % 3] });
  const a = stratifiedSample(rows, 30, 7);
  const b = stratifiedSample([...rows].reverse(), 30, 7);
  assert.deepEqual(
    a.map((r) => r.id),
    b.map((r) => r.id)
  );
  assert.notDeepEqual(
    a.map((r) => r.id),
    stratifiedSample(rows, 30, 8).map((r) => r.id)
  );
  const counts = {};
  for (const r of a) counts[r.bucket] = (counts[r.bucket] ?? 0) + 1;
  assert.deepEqual(counts, { "under-3s": 10, "3-15s": 10, "over-15s": 10 });
  assert.equal(new Set(a.map((r) => r.id)).size, 30);
});

test("stratifiedSample gives a short bucket's share to the others", async () => {
  const { stratifiedSample } = await load();
  const rows = [{ id: 1, audio_duration_ms: 1000 }];
  for (let i = 2; i < 40; i++) rows.push({ id: i, audio_duration_ms: i % 2 ? 8000 : 30000 });
  const s = stratifiedSample(rows, 21, 1);
  assert.equal(s.length, 21);
  assert.equal(s.filter((r) => r.bucket === "under-3s").length, 1);
  assert.equal(stratifiedSample(rows, 500, 1).length, rows.length);
});

test("percentile uses nearest rank", async () => {
  const { percentile } = await load();
  const v = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10];
  assert.equal(percentile(v, 50), 5);
  assert.equal(percentile(v, 90), 9);
  assert.equal(percentile(v, 95), 10);
  assert.equal(percentile([], 50), null);
});

test("summarize pools WER per model and bucket and counts errors", async () => {
  const { summarize } = await load();
  const s = summarize([
    { model: "m", bucket: "under-3s", latencyMs: 100, agreement: { errors: 1, refWords: 2 } },
    {
      model: "m",
      bucket: "under-3s",
      latencyMs: 300,
      agreement: { errors: 0, refWords: 8 },
      gold: { errors: 2, refWords: 8 },
    },
    { model: "m", bucket: "over-15s", error: "HTTP 500" },
  ]);
  assert.equal(s.m.all.clips, 3);
  assert.equal(s.m.all.errors, 1);
  assert.equal(s.m.all.agreementWer, 0.1);
  assert.equal(s.m.all.goldWer, 0.25);
  assert.equal(s.m.all.goldClips, 1);
  assert.deepEqual(s.m.buckets["under-3s"].latencyMs, { median: 100, p90: 300, p95: 300 });
  assert.equal(s.m.buckets["over-15s"].agreementWer, null);
  assert.equal(s.m.buckets["3-15s"].clips, 0);
});

test("summarize keeps models apart and an errored clip adds no latency or WER", async () => {
  const { summarize } = await load();
  const s = summarize([
    { model: "a", bucket: "3-15s", latencyMs: 200, agreement: { errors: 1, refWords: 4 } },
    { model: "b", bucket: "3-15s", latencyMs: 900, agreement: { errors: 4, refWords: 4 } },
    {
      model: "b",
      bucket: "3-15s",
      latencyMs: 5,
      error: "HTTP 500",
      agreement: { errors: 0, refWords: 100 },
    },
  ]);
  assert.deepEqual(Object.keys(s), ["a", "b"]);
  assert.equal(s.a.all.agreementWer, 0.25);
  assert.equal(s.b.all.clips, 2);
  assert.equal(s.b.all.errors, 1);
  assert.equal(s.b.all.agreementWer, 1);
  assert.deepEqual(s.b.all.latencyMs, { median: 900, p90: 900, p95: 900 });
});

test("summaryMarkdown prints an all row and one row per bucket, n/a for no data", async () => {
  const { summarize, summaryMarkdown } = await load();
  const md = summaryMarkdown(
    summarize([
      {
        model: "m",
        bucket: "under-3s",
        latencyMs: 120,
        agreement: { errors: 1, refWords: 4 },
        gold: { errors: 1, refWords: 2 },
      },
    ]),
    { sample: 1, seed: 7, endpoint: "http://stub" }
  );
  assert.match(md, /^# STT A\/B summary\n/);
  assert.match(md, /Sample: 1 clips, seed 7, endpoint http:\/\/stub\./);
  const rows = md.split("\n").filter((l) => l.startsWith("| m |"));
  assert.deepEqual(rows, [
    "| m | all | 1 | 0 | 0.250 | 0.500 (1) | 120 / 120 / 120 |",
    "| m | under-3s | 1 | 0 | 0.250 | 0.500 (1) | 120 / 120 / 120 |",
    "| m | 3-15s | 0 | 0 | n/a | n/a (0) | n/a / n/a / n/a |",
    "| m | over-15s | 0 | 0 | n/a | n/a (0) | n/a / n/a / n/a |",
  ]);
  assert.ok(md.endsWith("|\n"));
});

test("goldCandidates draws only from the replay sample, still stratified", async () => {
  const { stratifiedSample, goldCandidates } = await load();
  const rows = Array.from({ length: 300 }, (_, i) => ({
    id: i + 1,
    audio_duration_ms: [1000, 8000, 30000][i % 3],
  }));
  const sample = stratifiedSample(rows, 60, 550);
  const picks = goldCandidates(sample, 15, 550);
  const sampleIds = new Set(sample.map((r) => r.id));
  assert.equal(picks.length, 15);
  for (const p of picks) assert.ok(sampleIds.has(p.id), `gold candidate ${p.id} not in sample`);
  const perBucket = (b) => picks.filter((p) => p.bucket === b).length;
  assert.deepEqual([perBucket("under-3s"), perBucket("3-15s"), perBucket("over-15s")], [5, 5, 5]);
  assert.equal(goldCandidates(sample, 500, 550).length, sample.length);
});

const loadWav = () =>
  import(pathToFileURL(path.join(__dirname, "../../scripts/stt-ab/wav.mjs")).href);

test("convertToWav leaves no wav after a failed conversion and retries next time", async () => {
  const fs = require("fs");
  const { convertToWav } = await loadWav();
  const dir = fs.mkdtempSync(path.join(__dirname, ".stt-ab-wav-"));
  try {
    const out = path.join(dir, "7.wav");
    const calls = [];
    const failing = (target) => {
      calls.push(target);
      fs.writeFileSync(target, "partial");
      return { status: 1, stderr: "boom" };
    };
    assert.throws(() => convertToWav(out, failing), /ffmpeg failed: boom/);
    assert.equal(fs.existsSync(out), false);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.notEqual(calls[0], out);

    const working = (target) => {
      calls.push(target);
      fs.writeFileSync(target, "RIFF");
      return { status: 0 };
    };
    assert.equal(convertToWav(out, working), out);
    assert.equal(calls.length, 2);
    assert.equal(fs.readFileSync(out, "utf8"), "RIFF");
    assert.deepEqual(fs.readdirSync(dir), ["7.wav"]);
    convertToWav(out, working);
    assert.equal(calls.length, 2, "an existing wav is reused");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("convertToWav names the spawn error when ffmpeg cannot start", async () => {
  const fs = require("fs");
  const { convertToWav } = await loadWav();
  const dir = fs.mkdtempSync(path.join(__dirname, ".stt-ab-wav-"));
  try {
    const unspawnable = () => ({
      status: null,
      stderr: null,
      error: new Error("spawn ffmpeg ENOENT"),
    });
    assert.throws(
      () => convertToWav(path.join(dir, "8.wav"), unspawnable),
      /ffmpeg failed: spawn ffmpeg ENOENT/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run.mjs rejects bad arguments before touching data", () => {
  const { spawnSync } = require("child_process");
  const fs = require("fs");
  const runner = path.join(__dirname, "../../scripts/stt-ab/run.mjs");
  const dir = fs.mkdtempSync(path.join(__dirname, ".stt-ab-args-"));
  try {
    const goldFile = (name, body) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, body);
      return f;
    };
    const bad = [
      // above 2147483647 Node fires the timer after 1 ms
      ["--models", "m", "--timeout-ms", "2147483648"],
      // the generator takes seed >>> 0, so wider values alias
      ["--models", "m", "--seed=-1"],
      ["--models", "m", "--seed", "4294967296"],
      ["--models", "m", "--endpoint", "notaurl"],
      ["--models", "m", "--endpoint", "ftp://x"],
      ["--models", "m, m"],
      ["--models", "m", "--gold", path.join(dir, "missing.jsonl")],
      ["--models", "m", "--gold", goldFile("badjson.jsonl", '{"id":1,"text":"a"}\n{nope\n')],
      ["--models", "m", "--gold", goldFile("notext.jsonl", '{"id":2}\n')],
      [
        "--models",
        "m",
        "--gold",
        goldFile("dup.jsonl", '{"id":3,"text":"a"}\n\n{"id":"3","text":"b"}\n'),
      ],
      // punctuation alone scores as zero reference words
      ["--models", "m", "--gold", goldFile("punct.jsonl", '{"id":4,"text":"..."}\n')],
      ["--models", ","],
      ["--models", "m", "--timeout-ms", "abc"],
      ["--models", "m", "--timeout-ms", "-5"],
      ["--models", "m", "--sample", "0"],
      ["--models", "m", "--seed", "x"],
      ["--models", "m", "--gold-candidates", "-1"],
      // review on #562: the timeout is a whole number of milliseconds
      ["--models", "m", "--timeout-ms", "100.5"],
      ["--models", "m", "--timeout-ms", "4294967296"],
      // Number() reads these as numbers; the runner takes decimal integers only
      ["--models", "m", "--timeout-ms", "0x10"],
      ["--models", "m", "--sample", "1e3"],
      ["--models", "m", "--seed", ""],
      ["--models", "m", "--sample", " "],
      ["--models", "m", "--gold-candidates", "1.5"],
    ];
    for (const argv of bad) {
      const out = path.join(dir, "out");
      const r = spawnSync(process.execPath, [runner, ...argv, "--out", out], {
        encoding: "utf8",
        env: { ...process.env, STT_AB_DATA_ROOT: path.join(dir, "no-data") },
      });
      assert.equal(r.status, 2, `${argv.join(" ")} -> exit ${r.status}: ${r.stderr}`);
      assert.equal(fs.existsSync(out), false, `${argv.join(" ")} created the output dir`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A data root the runner's SELECT accepts: one completed turbo row per id,
// each with an audio file.
function makeData(dir, ids) {
  const fs = require("fs");
  const { DatabaseSync } = require("node:sqlite");
  const data = path.join(dir, "data");
  fs.mkdirSync(path.join(data, "audio"), { recursive: true });
  const db = new DatabaseSync(path.join(data, "transcriptions.db"));
  db.exec(
    "CREATE TABLE transcriptions (id INTEGER, audio_duration_ms INTEGER, raw_text TEXT, has_audio INTEGER, status TEXT, deleted_at TEXT, model TEXT)"
  );
  const insert = db.prepare(
    "INSERT INTO transcriptions VALUES (?, 2000, 'hello world', 1, 'completed', NULL, 'whisper-large-v3-turbo')"
  );
  for (const id of ids) {
    insert.run(id);
    fs.writeFileSync(path.join(data, "audio", `OpenWhispr-2026-01-01-00-00-00-${id}.webm`), "");
  }
  db.close();
  return data;
}

// Runs run.mjs against a local stub endpoint. The wavs are made up front, so
// ffmpeg is never needed. The runner is spawned async: the stub shares this
// event loop.
async function runAgainstStub(
  dir,
  { ids = [1], respond, args = [], before, nodeArgs = [], onStderr } = {}
) {
  const fs = require("fs");
  const http = require("http");
  const { spawn } = require("child_process");
  const data = makeData(dir, ids);
  const out = path.join(dir, "out");
  fs.mkdirSync(path.join(out, "wav"), { recursive: true });
  for (const id of ids) fs.writeFileSync(path.join(out, "wav", `${id}.wav`), "RIFF");
  if (before) before(out);
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      // an optional third value, a promise, holds the body back after the
      // headers are sent until it resolves
      const [status, body, release] = respond();
      res.writeHead(status, { "content-type": "application/json" });
      res.flushHeaders();
      Promise.resolve(release).then(() => res.end(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/audio/transcriptions`;
  try {
    const runner = path.join(__dirname, "../../scripts/stt-ab/run.mjs");
    const child = spawn(
      process.execPath,
      [...nodeArgs, runner, "--models", "m", "--out", out, "--endpoint", endpoint, ...args],
      { env: { ...process.env, STT_AB_DATA_ROOT: data } }
    );
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
      if (onStderr) onStderr(stderr);
    });
    child.stdout.resume();
    const status = await new Promise((resolve) => child.on("close", resolve));
    const clipsFile = path.join(out, "clips.jsonl");
    const rows = fs.existsSync(clipsFile)
      ? fs
          .readFileSync(clipsFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    return { status, stderr, out, rows };
  } finally {
    server.close();
  }
}

test("run.mjs exits 1 on missing data before creating the output dir", () => {
  const { spawnSync } = require("child_process");
  const fs = require("fs");
  const runner = path.join(__dirname, "../../scripts/stt-ab/run.mjs");
  const dir = fs.mkdtempSync(path.join(__dirname, ".stt-ab-nodata-"));
  try {
    const run = (root) => {
      const out = path.join(dir, "out");
      const r = spawnSync(process.execPath, [runner, "--models", "m", "--out", out], {
        encoding: "utf8",
        env: { ...process.env, STT_AB_DATA_ROOT: root },
      });
      return { ...r, outExists: fs.existsSync(out) };
    };
    const missing = run(path.join(dir, "no-data"));
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /^run\.mjs: cannot open .*transcriptions\.db: /);
    assert.doesNotMatch(missing.stderr, /\n\s+at /, "no stack trace");
    assert.equal(missing.outExists, false);

    const empty = run(makeData(path.join(dir, "empty"), []));
    assert.equal(empty.status, 1, empty.stderr);
    assert.equal(empty.stderr.trim(), "run.mjs: no eligible clips");
    assert.equal(empty.outExists, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run.mjs transcribes a clip at the top of the timeout range", async () => {
  const fs = require("fs");
  const dir = fs.mkdtempSync(path.join(__dirname, ".stt-ab-ok-"));
  try {
    const r = await runAgainstStub(dir, {
      respond: () => [200, '{"text":"hello world"}'],
      args: ["--timeout-ms", "2147483647", "--seed", "4294967295"],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].text, "hello world");
    assert.equal(r.rows[0].error, undefined);
    assert.equal(typeof r.rows[0].latencyMs, "number");
    assert.deepEqual(r.rows[0].agreement, { errors: 0, refWords: 2 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run.mjs exits 1 when every request failed, after writing the summary", async () => {
  const fs = require("fs");
  const dir = fs.mkdtempSync(path.join(__dirname, ".stt-ab-500-"));
  try {
    const r = await runAgainstStub(dir, { ids: [1, 2], respond: () => [500, "{}"] });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /run\.mjs: every request failed \(HTTP 500\)/);
    assert.ok(fs.existsSync(path.join(r.out, "summary.json")));
    assert.ok(fs.existsSync(path.join(r.out, "summary.md")));
    assert.equal(r.rows.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run.mjs exits 1 when one model fails every clip, naming it", async () => {
  const fs = require("fs");
  const dir = fs.mkdtempSync(path.join(__dirname, ".stt-ab-deadmodel-"));
  try {
    // Models run in order, so the first model's two clips come first.
    let n = 0;
    const r = await runAgainstStub(dir, {
      ids: [1, 2],
      respond: () => (n++ < 2 ? [200, '{"text":"hello world"}'] : [404, "{}"]),
      args: ["--models", "good,goood"],
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /run\.mjs: every request failed for goood/);
    assert.ok(fs.existsSync(path.join(r.out, "summary.md")));
    assert.equal(r.rows.length, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run.mjs exits 0 on partial failure but names the count", async () => {
  const fs = require("fs");
  const dir = fs.mkdtempSync(path.join(__dirname, ".stt-ab-partial-"));
  try {
    let n = 0;
    const r = await runAgainstStub(dir, {
      ids: [1, 2],
      respond: () => (n++ === 0 ? [500, "{}"] : [200, '{"text":"hi"}']),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /run\.mjs: 1 of 2 requests failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run.mjs treats a 200 without a text field as a clip error", async () => {
  const fs = require("fs");
  const dir = fs.mkdtempSync(path.join(__dirname, ".stt-ab-notext-"));
  try {
    const r = await runAgainstStub(dir, { respond: () => [200, "{}"] });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].error, "response has no text");
    assert.equal(r.rows[0].text, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run.mjs removes a stale gold-candidates file when the flag is absent", async () => {
  const fs = require("fs");
  const dir = fs.mkdtempSync(path.join(__dirname, ".stt-ab-stale-"));
  try {
    const r = await runAgainstStub(dir, {
      respond: () => [200, '{"text":"hello world"}'],
      before: (out) => fs.writeFileSync(path.join(out, "gold-candidates.jsonl"), "old\n"),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(path.join(r.out, "gold-candidates.jsonl")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run.mjs writes an empty gold-candidates file for --gold-candidates 0", async () => {
  const fs = require("fs");
  const dir = fs.mkdtempSync(path.join(__dirname, ".stt-ab-gold0-"));
  try {
    const r = await runAgainstStub(dir, {
      respond: () => [200, '{"text":"hello world"}'],
      args: ["--gold-candidates", "0"],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(r.out, "gold-candidates.jsonl"), "utf8"), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run.mjs reports how many gold ids are in the sample", async () => {
  const fs = require("fs");
  const dir = fs.mkdtempSync(path.join(__dirname, ".stt-ab-goldn-"));
  try {
    const gold = path.join(dir, "gold.jsonl");
    // A leading BOM, as some editors save it, is not part of the first record.
    fs.writeFileSync(gold, '﻿{"id":1,"text":"hello world"}\n{"id":"99","text":"absent"}\n');
    const r = await runAgainstStub(dir, {
      respond: () => [200, '{"text":"hello world"}'],
      args: ["--gold", gold],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /gold: 1 of 2 ids in the sample/);
    assert.deepEqual(r.rows[0].gold, { errors: 0, refWords: 2 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Preloaded into the runner: a test-owned clock behind performance.now that
// moves only when the runner reads the end of a response body, plus a stderr
// line once fetch has resolved on the headers. Wall time never enters it.
const BODY_CLOCK = `
let t = 0;
Object.defineProperty(globalThis.performance, "now", { value: () => t });
const realFetch = globalThis.fetch;
globalThis.fetch = async (...a) => {
  const res = await realFetch(...a);
  process.stderr.write("stt-ab-test: headers\\n");
  const reader = res.body.getReader();
  const body = new ReadableStream(
    {
      async pull(c) {
        const { done, value } = await reader.read();
        if (done) {
          t += 1234;
          c.close();
        } else c.enqueue(value);
      },
    },
    { highWaterMark: 0 }
  );
  return new Response(body, { status: res.status, headers: res.headers });
};
`;

// Review on #557: fetch resolves on the headers, so a clock stopped there
// misses the time the server spends sending the transcript.
test("run.mjs latency includes reading the response body", async () => {
  const fs = require("fs");
  const dir = fs.mkdtempSync(path.join(__dirname, ".stt-ab-slowbody-"));
  try {
    // The body is sent only once the runner holds the headers.
    let release;
    const headersSeen = new Promise((resolve) => (release = resolve));
    const r = await runAgainstStub(dir, {
      nodeArgs: ["--import", `data:text/javascript,${encodeURIComponent(BODY_CLOCK)}`],
      onStderr: (s) => s.includes("stt-ab-test: headers") && release(),
      respond: () => [200, '{"text":"hello world"}', headersSeen],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.rows[0].latencyMs, 1234, "the clock stops before the body is read");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run.mjs rejects a gold file that matches no clip in the sample", async () => {
  const fs = require("fs");
  const dir = fs.mkdtempSync(path.join(__dirname, ".stt-ab-goldnone-"));
  try {
    const none = path.join(dir, "none.jsonl");
    fs.writeFileSync(none, '{"id":9999,"text":"zzz"}\n');
    // A fresh --out (the last flag wins) shows the check runs before mkdir.
    const fresh = path.join(dir, "fresh-out");
    const r = await runAgainstStub(dir, {
      respond: () => [200, '{"text":"hello world"}'],
      args: ["--gold", none, "--out", fresh],
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /none of the 1 gold ids are in the sample/);
    assert.equal(r.rows.length, 0, "no request was sent");
    assert.equal(fs.existsSync(fresh), false, "the output dir was created");

    const empty = path.join(dir, "empty.jsonl");
    fs.writeFileSync(empty, "\n");
    const e = await runAgainstStub(path.join(dir, "e"), {
      respond: () => [200, '{"text":"hello world"}'],
      args: ["--gold", empty],
    });
    assert.equal(e.status, 2, e.stderr);
    assert.match(e.stderr, /has no records/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run.mjs gives a one-line reason when --out cannot be created", () => {
  const { spawnSync } = require("child_process");
  const fs = require("fs");
  const runner = path.join(__dirname, "../../scripts/stt-ab/run.mjs");
  const dir = fs.mkdtempSync(path.join(__dirname, ".stt-ab-outfile-"));
  try {
    const data = makeData(dir, [1]);
    const out = path.join(dir, "a-file");
    fs.writeFileSync(out, "");
    const r = spawnSync(process.execPath, [runner, "--models", "m", "--out", out], {
      encoding: "utf8",
      env: { ...process.env, STT_AB_DATA_ROOT: data },
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /^run\.mjs: cannot create .*a-file: /);
    assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
