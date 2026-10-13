import { loadConfig } from "./config.ts";
import { createVoiceServer, reapExpiredSessions } from "./app.ts";
import { SessionStore } from "./store.ts";
import { RoomServiceClient } from "livekit-server-sdk";

const config = loadConfig();
const store = new SessionStore(config.dbPath);
const rooms = new RoomServiceClient(
  config.livekitInternalUrl,
  config.livekitApiKey,
  config.livekitApiSecret
);
await reapExpiredSessions(store, rooms);
const expiryTimer = setInterval(() => {
  void reapExpiredSessions(store, rooms);
}, 60_000);
expiryTimer.unref();
const server = createVoiceServer({ config, store, rooms });
server.listen(config.port, config.host, () =>
  process.stdout.write(`voice gateway listening on ${config.host}:${config.port}\n`)
);
const stop = (): void => {
  clearInterval(expiryTimer);
  server.close(() => {
    store.closeDb();
    process.exit(0);
  });
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
