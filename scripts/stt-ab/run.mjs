// STT A/B replay: re-transcribe a fixed, duration-stratified sample of
// dictation clips through an OpenAI-compatible endpoint, one request at a
// time, and score each model. See README.md in this folder.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import {
  goldCandidates,
  normalizeText,
  stratifiedSample,
  summarize,
  summaryMarkdown,
  werCounts,
} from "./scoring.mjs";
import { convertToWav, ffmpegRunner } from "./wav.mjs";

const DATA_ROOT = process.env.STT_AB_DATA_ROOT ?? path.join(os.homedir(), "rtech-whisper");
const DB_PATH = path.join(DATA_ROOT, "transcriptions.db");
const AUDIO_DIR = path.join(DATA_ROOT, "audio");
const BASELINE_MODEL = "whisper-large-v3-turbo";

function usage(why) {
  if (why) console.error(`run.mjs: ${why}`);
  console.error(
    "usage: node scripts/stt-ab/run.mjs --models a,b --sample N --seed n (0..4294967295) --out <dir> [--gold f.jsonl] [--endpoint url] [--language en] [--gold-candidates N] [--timeout-ms ms]"
  );
  process.exit(2);
}

// Missing data: exit 1 with a one-line reason, no stack trace.
function fail(why) {
  console.error(`run.mjs: ${why}`);
  process.exit(1);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      models: { type: "string" },
      sample: { type: "string", default: "200" },
      seed: { type: "string", default: "550" },
      gold: { type: "string" },
      endpoint: {
        type: "string",
        default: "http://localhost:8080/v1/audio/transcriptions",
      },
      language: { type: "string" },
      "timeout-ms": { type: "string", default: "120000" },
      "gold-candidates": { type: "string" },
      out: { type: "string" },
    },
  }));
} catch (err) {
  usage(err.message);
}
if (!args.models || !args.out) usage();
const models = (args.models ?? "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
// A decimal integer in [min, max], or usage. Number() alone would take "",
// " ", "0x10" and "1e3", and a bad value would fail every clip and still exit 0.
function intArg(name, min, max) {
  const raw = args[name];
  const n = /^-?\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    usage(`--${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
  }
  return n;
}
if (!models.length) usage("--models names no model");
const dupModel = models.find((m, i) => models.indexOf(m) !== i);
if (dupModel) usage(`--models names "${dupModel}" twice`);
const sampleN = intArg("sample", 1, Number.MAX_SAFE_INTEGER);
// the generator takes seed >>> 0, so a wider value would alias another seed
const seed = intArg("seed", 0, 4294967295);
// Node's timers are signed 32-bit: above 2147483647 the timer fires after 1 ms;
// 0 would abort every request
const timeoutMs = intArg("timeout-ms", 1, 2147483647);
const goldCandidateN =
  args["gold-candidates"] == null ? null : intArg("gold-candidates", 0, Number.MAX_SAFE_INTEGER);
let endpointUrl;
try {
  endpointUrl = new URL(args.endpoint);
} catch {}
if (!endpointUrl || !["http:", "https:"].includes(endpointUrl.protocol)) {
  usage(`--endpoint must be an http or https URL, got "${args.endpoint}"`);
}

// Gold JSONL: one {id, text} per non-blank line, id integer-valued, text with at
// least one word as scored (punctuation alone would count as zero reference
// words). A leading BOM is dropped.
const gold = new Map();
if (args.gold) {
  let lines;
  try {
    lines = fs
      .readFileSync(args.gold, "utf8")
      .replace(/^\uFEFF/, "")
      .split("\n");
  } catch (err) {
    usage(`--gold ${args.gold}: ${err.message}`);
  }
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const where = `--gold ${args.gold} line ${i + 1}`;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (err) {
      usage(`${where}: ${err.message}`);
    }
    const id =
      typeof rec?.id === "number" || (typeof rec?.id === "string" && /^-?\d+$/.test(rec.id))
        ? Number(rec.id)
        : NaN;
    if (!Number.isSafeInteger(id)) usage(`${where}: id must be a whole number`);
    if (typeof rec.text !== "string" || !normalizeText(rec.text).length) {
      usage(`${where}: text must be a string with at least one word`);
    }
    if (gold.has(id)) usage(`${where}: duplicate id ${id}`);
    gold.set(id, rec.text);
  });
  if (!gold.size) usage(`--gold ${args.gold} has no records`);
}

// Read-only open: the app's WAL stays untouched.
let rows;
try {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    rows = db
      .prepare(
        `SELECT id, audio_duration_ms, raw_text FROM transcriptions
         WHERE has_audio = 1 AND status = 'completed' AND deleted_at IS NULL
           AND model = ? AND audio_duration_ms IS NOT NULL`
      )
      .all(BASELINE_MODEL);
  } finally {
    db.close();
  }
} catch (err) {
  fail(`cannot open ${DB_PATH}: ${err.message}`);
}

// File names end in -<transcriptions.id>.webm.
let audioFiles;
try {
  audioFiles = fs.readdirSync(AUDIO_DIR);
} catch (err) {
  fail(`cannot open ${AUDIO_DIR}: ${err.message}`);
}
const audioById = new Map();
for (const f of audioFiles) {
  const m = f.match(/^OpenWhispr-.*-(\d+)\.webm$/);
  if (m) audioById.set(Number(m[1]), path.join(AUDIO_DIR, f));
}
const eligible = rows.filter((r) => audioById.has(r.id));
if (!eligible.length) fail("no eligible clips");
const sample = stratifiedSample(eligible, sampleN, seed);

// A gold file that scores nothing would leave gold WER n/a for every model.
if (args.gold) {
  const sampleIds = new Set(sample.map((c) => c.id));
  const found = [...gold.keys()].filter((id) => sampleIds.has(id)).length;
  if (!found) usage(`--gold: none of the ${gold.size} gold ids are in the sample`);
  console.error(`gold: ${found} of ${gold.size} ids in the sample`);
}

// Every input is valid; only now does the output folder appear.
try {
  fs.mkdirSync(args.out, { recursive: true });
} catch (err) {
  fail(`cannot create ${args.out}: ${err.message}`);
}

function ffmpegBinary() {
  try {
    const p = createRequire(import.meta.url)("ffmpeg-static");
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return "ffmpeg";
}
const FFMPEG = ffmpegBinary();

const goldCandidatesFile = path.join(args.out, "gold-candidates.jsonl");
if (goldCandidateN != null) {
  const picks = goldCandidates(sample, goldCandidateN, seed);
  fs.writeFileSync(
    goldCandidatesFile,
    // one newline per record, so zero picks is an empty file, not a blank line
    picks
      .map(
        (r) =>
          JSON.stringify({
            id: r.id,
            audio_duration_ms: r.audio_duration_ms,
            bucket: r.bucket,
            file: path.basename(audioById.get(r.id)),
          }) + "\n"
      )
      .join("")
  );
} else {
  // an old file must not sit beside new results as if this run drew it
  fs.rmSync(goldCandidatesFile, { force: true });
}

const wavDir = path.join(args.out, "wav");
fs.mkdirSync(wavDir, { recursive: true });

function toWav(id) {
  const src = audioById.get(id);
  return convertToWav(path.join(wavDir, `${id}.wav`), ffmpegRunner(FFMPEG, src));
}

async function transcribe(model, wavPath) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(wavPath)], { type: "audio/wav" }), "clip.wav");
  form.append("model", model);
  form.append("response_format", "json");
  if (args.language) form.append("language", args.language);
  const started = performance.now();
  const res = await fetch(args.endpoint, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  // fetch resolves on the headers; the transcript is in the body, so the
  // clock stops only after the body is read.
  const body = res.ok ? await res.json() : null;
  const latencyMs = Math.round(performance.now() - started);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { latencyMs });
  // a 200 without a transcript is a failed clip, not an empty one
  if (typeof body?.text !== "string") {
    throw Object.assign(new Error("response has no text"), { latencyMs });
  }
  return { text: body.text, latencyMs };
}

const results = [];
const clipsFile = path.join(args.out, "clips.jsonl");
fs.writeFileSync(clipsFile, "");
let done = 0;
for (const model of models) {
  for (const clip of sample) {
    const row = { model, id: clip.id, bucket: clip.bucket, durationMs: clip.audio_duration_ms };
    try {
      const { text, latencyMs } = await transcribe(model, toWav(clip.id));
      row.latencyMs = latencyMs;
      row.text = text;
      row.agreement = werCounts(clip.raw_text ?? "", text);
      if (gold.has(clip.id)) row.gold = werCounts(gold.get(clip.id), text);
    } catch (err) {
      row.error = err.name === "TimeoutError" ? `timeout ${timeoutMs}ms` : err.message;
      if (err.latencyMs != null) row.latencyMs = err.latencyMs;
    }
    results.push(row);
    fs.appendFileSync(clipsFile, JSON.stringify(row) + "\n");
    done++;
    if (done % 25 === 0) console.error(`${done}/${models.length * sample.length}`);
  }
}

const summary = summarize(results);
const meta = {
  sample: sample.length,
  seed,
  endpoint: args.endpoint,
  models,
  language: args.language ?? null,
};
fs.writeFileSync(path.join(args.out, "summary.json"), JSON.stringify({ meta, summary }, null, 2));
fs.writeFileSync(path.join(args.out, "summary.md"), summaryMarkdown(summary, meta));
fs.rmSync(wavDir, { recursive: true, force: true });
console.log(`wrote ${path.join(args.out, "summary.md")}`);

const failed = results.filter((r) => r.error);
if (failed.length === results.length) {
  console.error(`run.mjs: every request failed (${failed[0].error})`);
  process.exit(1);
}
if (failed.length) console.error(`run.mjs: ${failed.length} of ${results.length} requests failed`);
// A model that failed every clip (a misspelled name, say) measured nothing.
const dead = models.filter((m) => results.every((r) => r.model !== m || r.error));
if (dead.length) {
  console.error(`run.mjs: every request failed for ${dead.join(", ")}`);
  process.exit(1);
}
