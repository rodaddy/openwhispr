// TranscriptionsService.list query shape (#119): the cursor id rides as
// since_id on a delta page and before_id on a snapshot page, and never alone.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  installBrowserGlobals,
  resetBrowserGlobals,
  window: windowStub,
} = require("../helpers/harness/browserGlobals.js");
const { TranscriptionsService } = require("../../src/services/TranscriptionsService.ts");

const STAMP = "2026-09-20T12:00:00.000Z";

async function pathFor(...args) {
  resetBrowserGlobals();
  installBrowserGlobals();
  const paths = [];
  windowStub.electronAPI = {
    cloudApiRequest: async (opts) => {
      paths.push(opts.path);
      return { success: true, data: { transcriptions: [] } };
    },
  };
  await TranscriptionsService.list(...args);
  return paths[0];
}

test("a delta page sends since and since_id", async () => {
  assert.equal(
    await pathFor(100, undefined, STAMP, "trans-0050"),
    "/api/transcriptions/list?limit=100&since=2026-09-20T12%3A00%3A00.000Z&since_id=trans-0050"
  );
});

test("a snapshot page sends before and before_id", async () => {
  assert.equal(
    await pathFor(100, STAMP, undefined, "trans-0050"),
    "/api/transcriptions/list?limit=100&before=2026-09-20T12%3A00%3A00.000Z&before_id=trans-0050"
  );
});

test("a cursor id without a stamp is not sent", async () => {
  assert.equal(
    await pathFor(100, undefined, undefined, "trans-0050"),
    "/api/transcriptions/list?limit=100"
  );
});

test("a stamp without an id keeps the stamp-only query", async () => {
  assert.equal(
    await pathFor(100, undefined, STAMP),
    "/api/transcriptions/list?limit=100&since=2026-09-20T12%3A00%3A00.000Z"
  );
});
