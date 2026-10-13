# STT A/B replay (#550)

Re-transcribes a fixed sample of past dictation clips through an
OpenAI-compatible `/v1/audio/transcriptions` endpoint (a self-hosted llama-swap server by
default, set with `--endpoint`) and scores each model. Speech-to-text only.

```
node scripts/stt-ab/run.mjs --models whisper-large-v3-turbo,<candidate> \
  --sample 200 --seed 550 --out <dir> [--gold gold.jsonl] \
  [--endpoint URL] [--language en] [--gold-candidates 50] [--timeout-ms 120000]
```

- Sample: `has_audio=1`, `status='completed'`, not deleted, model
  `whisper-large-v3-turbo`, split evenly across under 3 s / 3-15 s / over 15 s.
  Same seed, same clips. Audio files map to rows by the `-<id>.webm` suffix.
- Requests are sequential, one model after another, never parallel.
  Each clip is converted to 16 kHz mono wav with the app's ffmpeg.
- The DB is opened read-only (`node:sqlite`, so no Electron-ABI native module).
  Data root override: `STT_AB_DATA_ROOT`.
- Agreement WER is against stored `raw_text`, i.e. the current model's own
  output. It is a screening number only: a model that matches turbo's mistakes
  scores well. Gold WER (`--gold`, JSONL `{id, text}`) is the accuracy number.
- WER is pooled (total errors / total reference words), after lowercasing,
  dropping punctuation, and splitting hyphenated words. Numbers are not
  spelled out. The app's dictionary prompt is not replayed.
- `--gold-candidates N` writes `gold-candidates.jsonl` (id, duration, bucket,
  file; no text) for hand transcription, drawn from the replay sample so
  every candidate is scored. Without the flag, a stale
  `gold-candidates.jsonl` in `--out` is removed.
- Every input is checked before `--out` is created. A bad argument
  (`--seed` outside 0..4294967295, `--timeout-ms` outside 1..2147483647, a
  non-http(s) `--endpoint`, a model named twice, a gold line that is not
  `{id, text}` with a whole-number id and non-empty text, or a duplicate gold
  id) exits 2. An unreadable database or audio folder, or no eligible clips,
  exits 1.
- A 200 response without a string `text` is a failed clip. If every request
  fails the run exits 1 after writing the summary; a partial failure exits 0
  and prints the count, unless one model failed every one of its clips (a
  misspelled model name, say): that exits 1 even when another model
  succeeded. With `--gold`, stderr says how many gold ids were in the sample.

Output in `--out`: `clips.jsonl` (per clip and model, includes transcripts:
keep it out of git), `summary.json`, `summary.md`.

Tests: `node --import tsx --test test/scripts/sttAb.test.js`.
