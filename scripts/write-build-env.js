#!/usr/bin/env node
// Writes build-time settings into the repo-root .env before a local build.
// electron-builder ships that file as Resources/.env (extraResources), and
// environment.js loads it at startup.
//
// Values come from the shell environment of the build, so nothing secret is
// stored in the repo:
//   GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET  (required)
//     A Google "Desktop app" OAuth client of your own. Without it every
//     calendar refresh fails with "The OAuth client was not found".
//   SHARE_SERVICE_URL, SHARE_SERVICE_TOKEN  (optional)
//     The note-share service (server/share). Without them the share dialog
//     says sharing isn't set up, and every other feature still works.
//   RTECH_WHISPER_HUB_URL, ASSISTANT_SPEECH_ENDPOINT  (optional)
//     The default sync hub and the self-hosted speech server.
//
// Other lines in .env are kept. Secret values are never printed.
//
// Usage: GOOGLE_CALENDAR_CLIENT_ID=... GOOGLE_CALENDAR_CLIENT_SECRET=... \
//          node scripts/write-build-env.js   (then npm run pack / build:mac)

const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", ".env");
const REQUIRED = ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET"];
const OPTIONAL = [
  "SHARE_SERVICE_URL",
  "SHARE_SERVICE_TOKEN",
  "RTECH_WHISPER_HUB_URL",
  "ASSISTANT_SPEECH_ENDPOINT",
];

function upsert(lines, key, value) {
  const at = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (at === -1) lines.push(`${key}=${value}`);
  else lines[at] = `${key}=${value}`;
}

function main() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`${missing.join(", ")} not set in the environment`);
  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const lines = existing.split("\n").filter((line) => line.length > 0);
  const written = [];
  for (const key of [...REQUIRED, ...OPTIONAL]) {
    if (!process.env[key]) continue;
    upsert(lines, key, process.env[key]);
    written.push(key);
  }
  fs.writeFileSync(ENV_PATH, `${lines.join("\n")}\n`, { mode: 0o600 });
  console.log(`Wrote ${written.join(", ")} to ${ENV_PATH}`);
  if (!process.env.SHARE_SERVICE_TOKEN)
    console.warn("write-build-env: SHARE_SERVICE_TOKEN not set; this build cannot share notes");
}

try {
  main();
} catch (error) {
  console.error(`write-build-env: ${error.message}`);
  process.exit(1);
}
