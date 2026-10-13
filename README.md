# rTech Whisper (desktop)

rTech Whisper is a fork of [OpenWhispr](https://github.com/OpenWhispr/openwhispr),
the open-source, MIT-licensed desktop dictation app by the OpenWhispr Team.
Almost everything here is their work: the Electron app, local Whisper and
Parakeet transcription, meetings, notes, and the agent. The full upstream
history is kept in this repository so that credit stays attached to every
commit. The upstream README is preserved at
[docs/UPSTREAM-README.md](docs/UPSTREAM-README.md).

## Why this fork exists

The author uses dictation all day on a Mac, mostly into terminals and coding
agents, with speech-to-text running on his own servers instead of a cloud API.
The fork carries the changes that workflow needed and that did not fit
upstream's product. It has its own version number (2.x), starting from
OpenWhispr 1.10.1.

## What the fork adds

- **Self-hosted speech-to-text everywhere.** Dictation, live preview, and note
  recording can post to any OpenAI-compatible `/v1/audio/transcriptions`
  endpoint (for example a llama-swap or whisper.cpp server on your LAN), with
  an away-from-home chain: sync hub first, then the self-hosted server
  directly, then a local engine.
- **Faster press-to-paste.** Recording starts on key press without the
  AppleScript round trips; tap-to-latch and hold-to-talk in one hybrid
  activation mode; latency is measured and shown per model on the Insights
  page.
- **App-aware formatting on macOS.** Dictation is formatted for the app it
  lands in, with an optional guarded Return after a paste into a terminal.
- **Filler-word removal** before cleanup or paste, with an editable list.
- **Sync hub (optional).** Chats and transcriptions sync through a
  self-hosted hub with a per-device key. The hub is a separate project; the
  app only speaks its HTTP protocol. Set the hub URL in Settings or with
  `RTECH_WHISPER_HUB_URL` (see `.env.example`). With no URL, sync is off.
- **Spoken assistant and "grill" interviews.** A voice assistant persona and a
  spoken interviewer mode that asks one question at a time and saves the
  session as a note. Speech comes from a self-hosted
  OmniVoice server
  (`ASSISTANT_SPEECH_ENDPOINT`) or an on-device engine. The interview prompts
  and question bank are written for the author; edit
  `src/config/grill/question-bank.md` and `src/config/prompts/` for your own.
- **GoHighLevel CRM connector.** File a note as a GoHighLevel note on a
  contact or opportunity.
- **Note sharing** through a small self-hosted share service
  (`server/share/`, with `apps/share/Dockerfile`).
- **`rtw` CLI and MCP server** (`tools/rtw/`) that talks to the running app over
  a loopback bridge, so coding agents can read and write notes.
- **Update checks are off** by default (`OPENWHISPR_ENABLE_UPDATES=1` restores
  them), since builds are distributed by hand.

`patches/` holds an early snapshot of the fork delta as `git format-patch`
files; `CHANGELOG.md` is the full record from 2.0.0 onward.

## How to run it

Requires Node.js 24 and macOS for the fork-specific features (most upstream
features also work on Windows and Linux).

```bash
git clone <this repository>
cd <checkout>
npm install
cp .env.example .env     # fill in what you use; every fork setting is optional
npm run dev
```

Tests: `npm test` (Node's test runner). Database-backed tests run under
Electron with `npm run test:db`.

A packaged build: `node scripts/write-build-env.js` (reads your Google Calendar
OAuth client and optional service settings from the environment into `.env`),
then `npm run build:mac`. Signing and notarization need your own Apple
Developer ID.

### Private dependency

The GoHighLevel connector imports `@rtech/connectors-highlevel`, which is not on
the public npm registry. `.npmrc` and `package-lock.json` point at a
placeholder registry (`npm.example.internal`). Until that package is published
somewhere public, either point `.npmrc` at a registry that hosts it, or remove
the dependency and the CRM connector, before `npm install` will succeed.

## What it does not do

- It is not a hosted product and has no installer download here. You build it.
- It does not ship the sync hub, the speech server, or any of the author's
  servers. The defaults point at nothing (sync off, speech at `localhost`).
- It does not track upstream automatically. Upstream fixes are merged by hand.
- It does not follow upstream's version numbers or release channel.

## Status

Production use: one person, daily, on Apple Silicon Macs, since September
2026, with self-hosted speech-to-text on a home LAN. Signed and notarized
builds have been made and installed on those machines.

Not proven: Windows and Linux builds of the fork's changes, Intel Macs, the
spoken grill and voice features outside the author's own server setup, and any
multi-user deployment of the hub or share service. The upstream features
carry upstream's own maturity.

## License

MIT. See [LICENSE](LICENSE): the original OpenWhispr copyright is kept, and the
fork's changes are copyright Rico Rojas.
