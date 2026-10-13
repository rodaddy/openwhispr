const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// The press-time meeting check is not awaited at start, so AudioManager holds
// the take's answer as a promise. Every history decision awaits it: a highlight
// never enters dictation history, failed or discarded, however fast the take.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function setup(t) {
  const harness = await loadAudioManager(t, {
    cachePrefix: "openwhispr-meeting-highlight-test-",
    settingsKey: "__meetingHighlightSettings",
  });
  const saved = [];
  harness.window.electronAPI.saveTranscription = async (...args) => {
    saved.push(args);
    return { id: null };
  };
  return { ...harness, saved };
}

test("a discarded take waits for the pending meeting answer and saves no history row for a highlight", async (t) => {
  const { createManager, saved } = await setup(t);
  const manager = createManager({ persistHistory: true });
  const answer = deferred();
  manager.setMeetingHighlightRequested(answer.promise);

  const save = manager.saveDiscardedTranscription(null, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved.length, 0, "nothing is written before the answer arrives");
  answer.resolve(true);
  await save;
  assert.equal(saved.length, 0);
});

test("a discarded non-highlight take is still saved", async (t) => {
  const { createManager, saved } = await setup(t);
  const manager = createManager({ persistHistory: true });
  manager.setMeetingHighlightRequested(Promise.resolve(false));
  await manager.saveDiscardedTranscription(null, 1);
  assert.equal(saved.length, 1);
});

test("a failed highlight writes no history row and drops its audio", async (t) => {
  const { createManager, saved } = await setup(t);
  const manager = createManager({
    persistHistory: true,
    lastAudioBlob: new Blob(["x"]),
    lastAudioMetadata: { durationSeconds: 1 },
  });
  manager.setMeetingHighlightRequested(Promise.resolve(true));
  await manager.saveFailedTranscription("boom", "E_TEST", {});
  assert.equal(saved.length, 0);
  assert.equal(manager.lastAudioBlob, null);
  assert.equal(manager.lastAudioMetadata, null);
});

test("a rejected or non-boolean meeting answer is not a highlight", async (t) => {
  const { createManager } = await setup(t);
  const manager = createManager();
  manager.setMeetingHighlightRequested(Promise.reject(new Error("ipc down")));
  assert.equal(await manager.meetingHighlightRequested, false);
  manager.setMeetingHighlightRequested("meeting-1");
  assert.equal(await manager.meetingHighlightRequested, false);
  manager.setMeetingHighlightRequested(true);
  assert.equal(await manager.meetingHighlightRequested, true);
});
