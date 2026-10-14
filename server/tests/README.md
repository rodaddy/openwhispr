# Voice server checks

The Safari/browser voice client and the Playwright acceptance harness that
drove it were retired:
a native iPhone app replaces it.

What remains here:

- `test/voice-verifier.test.mjs` — functional tests for the receipt checker in
  `specs/voice-server.verify.mjs`. Run with:

  ```zsh
  cd server/tests
  /opt/homebrew/opt/node@24/bin/npm run check
  ```

- `voice-backend-smoke.py` — backend-only LiveKit smoke. It does not certify a
  client, SSO, or a microphone.

A full-phase `specs/voice-server.verify.mjs` run still needs a client receipt
matching `server/contracts/voice-session.json`. No client in this repo produces
one now; the iPhone app is the expected producer.
