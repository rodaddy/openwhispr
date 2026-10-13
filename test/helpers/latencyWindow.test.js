const test = require("node:test");
const assert = require("node:assert/strict");

test("eleven latencies keep the newest ten and their rounded mean", async () => {
  const { pushLatency } = await import("../../src/helpers/latencyWindow.js");

  let window = { samples: [] };
  for (const ms of [5000, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1004]) {
    window = pushLatency(window.samples, ms);
  }

  assert.deepEqual(window.samples, [100, 200, 300, 400, 500, 600, 700, 800, 900, 1004]);
  assert.equal(window.lastMs, 1004);
  // 5504 / 10 = 550.4
  assert.equal(window.averageMs, 550);
});

test("a latency that is not a finite number above zero changes nothing", async () => {
  const { pushLatency } = await import("../../src/helpers/latencyWindow.js");
  const samples = [120, 140];

  assert.deepEqual(pushLatency(samples, 0), { samples, lastMs: null, averageMs: null });
  assert.deepEqual(pushLatency(samples, Infinity), { samples, lastMs: null, averageMs: null });
  assert.deepEqual(samples, [120, 140]);
});
