import { loadConfig } from "./config.ts";
import { createShareServer } from "./app.ts";
import { ShareStore } from "./store.ts";

const config = loadConfig();
const store = new ShareStore(config.dbPath);
const server = createShareServer({ config, store });
server.listen(config.port, () =>
  process.stdout.write(`share service listening on port ${config.port}\n`)
);
const stop = (): void => {
  server.close(() => {
    store.closeDb();
    process.exit(0);
  });
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
