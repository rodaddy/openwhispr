# Shared voice server contract

This directory defines the first server/browser slice tracked by
openwhispr#32. It does
not replace desktop dictation or settle the backend notes/CRM ownership tracked
by openwhispr#28.

## Frozen deployment boundary

- An existing Linux VM (`voice-host` below), using native services.
- LiveKit listens on TCP 7880, TCP 7881, and UDP 50000-50100.
- A Python agent joins one independent LiveKit room per conversation and owns
  the SDK session lifecycle.
- A Node 24 gateway on port 8090 serves the browser and authenticated session
  API.
- The first browser proof runs two overlapping, independent voice
  conversations. Desktop becomes a client after this slice passes.

## Gateway API

- `GET /healthz` — process health.
- `GET /readyz` — required dependencies ready.
- `GET /api/config` — public LiveKit WebSocket URL only.
- `POST /api/sessions` — returns HTTP 201 with `sessionId`, `roomName`,
  `participantIdentity`, `token`, `expiresAt`, and `livekitUrl`.
- `POST /api/sessions/:id/token` — owner-only fresh participant identity/token.
- `DELETE /api/sessions/:id` — owner-only close.

The gateway trusts identity only from the edge peer verified during deployment
and the `X-Authentik-Uid` principal header. `VOICE_TRUSTED_PROXY_IPS` must hold
that verified peer; the concrete address remains an infrastructure verification
result rather than an application default. A client cannot supply its username.
Direct, spoofed, unauthenticated, and cross-owner requests fail closed. SQLite
stores user-scoped session metadata; room state is not durable business data.

## Configuration

Gateway: `VOICE_HOST`, `VOICE_PORT=8090`, `VOICE_DB_PATH`,
`VOICE_TRUSTED_PROXY_IPS`, `VOICE_IDENTITY_HEADER`, `VOICE_PUBLIC_ORIGIN`,
`LIVEKIT_URL` (public `wss://`), `LIVEKIT_INTERNAL_URL`
(internal `http://`), `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`.

Agent: `LIVEKIT_URL` (internal `ws://`), LiveKit keys, `STT_URL`, `STT_MODEL`,
optional `STT_API_KEY`, `OMNIVOICE_SYNTH_URL`, `TTS_PROFILE_DIR` containing
`ref.wav` and `ref.txt`, `LLM_BASE_URL`, `LLM_MODEL`, and optional
`LLM_API_KEY`. The initial LLM is local `qwen3-4b-instruct`; Codex proxy is
optional only after its protocol is probed. The full STT to LLM to Skippy TTS
path is mandatory; there is no replay demo or disabled-LLM acceptance path.

## Verification

Run Node 24 only:

```text
node specs/voice-server.verify.mjs --phase health
VOICE_ACCEPTANCE_RECEIPT=/path/to/receipt.json node specs/voice-server.verify.mjs --phase full
```

`VOICE_VERIFY_URL` defaults to `http://voice-host.example.internal:8090`; set it to your host. Full mode also
requires an integrity-bound browser receipt matching
`server/contracts/voice-session.json`: two distinct overlapping sessions,
audio/STT/LLM/24 kHz TTS evidence, auth negatives, interruption, reconnect,
restart persistence, source SHA, target hostname, commands, and readable files
whose SHA-256 hashes match. Health alone can never produce an overall pass.
