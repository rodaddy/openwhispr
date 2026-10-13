const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { installBrowserGlobals, installHookDom } = require("../lib/rendererTestHarness");

// Mounts the hook and records the phase every render returns, so a test can
// assert what the recording edge itself would paint. Each render also records
// the presentation the callers (App.jsx, the Agent overlay) derive from the
// same inputs, so a test can assert what the pill would actually wear.
async function mountEntrance(t) {
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const { useListeningEntrancePhase } =
    await import("../../src/hooks/useListeningEntrancePhase.ts");
  const { resolveListeningEntrancePresentation } =
    await import("../../src/helpers/voicePillPresentation.js");
  const root = createRoot(container);
  const rendered = [];
  const presented = [];
  function Harness({ isRecording, isArming }) {
    const phase = useListeningEntrancePhase(isRecording, { isArming });
    rendered.push(phase);
    presented.push(resolveListeningEntrancePresentation({ isRecording, isArming, phase }));
    return null;
  }
  return {
    rendered,
    presented,
    render: (props) => React.act(async () => root.render(React.createElement(Harness, props))),
    unmount: () => React.act(async () => root.unmount()),
  };
}

// The entrance timers run on node:test mock timers: no test waits on the clock.
function mockTimers(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return (ms) => React.act(async () => t.mock.timers.tick(ms));
}

test("#563: preparing -> recording paints the waveform on the edge, no staged entrance", async (t) => {
  const { rendered, render, unmount } = await mountEntrance(t);
  const settle = mockTimers(t);
  await render({ isRecording: false, isArming: true });
  const edge = rendered.length;
  await render({ isRecording: true, isArming: false });
  await settle(250);
  assert.deepEqual([...new Set(rendered.slice(edge))], ["waveform"]);
  await unmount();
});

test("#563: a recording without arming keeps the staged entrance", async (t) => {
  const { rendered, render, unmount } = await mountEntrance(t);
  const settle = mockTimers(t);
  await render({ isRecording: false, isArming: false });
  const edge = rendered.length;
  await render({ isRecording: true, isArming: false });
  assert.deepEqual(rendered.slice(edge), ["idle", "thinking"]);
  await settle(250);
  assert.equal(rendered.at(-1), "waveform");
  await unmount();
});

test("#563: a failed or cancelled start leaves the arming look", async (t) => {
  // App.jsx and the Agent overlay both feed isArming from lifecycle
  // "preparing"; cancel, Escape and a start error all clear it without ever
  // recording. The pill must drop the arming look on that same commit.
  const { presented, render, unmount } = await mountEntrance(t);
  await render({ isRecording: false, isArming: true });
  assert.equal(presented.at(-1).activeState, "arming");
  const edge = presented.length;
  await render({ isRecording: false, isArming: false });
  assert.ok(presented.length > edge, "the cancel must re-render the pill");
  for (const look of presented.slice(edge)) {
    assert.deepEqual(look, {
      activeState: null,
      collapseToLogo: false,
      compactPill: false,
      waveformVisible: true,
    });
  }
  await unmount();
});

test("#563: a start that failed back to idle does not skip the next entrance", async (t) => {
  const { rendered, render, unmount } = await mountEntrance(t);
  await render({ isRecording: false, isArming: true });
  await render({ isRecording: false, isArming: false });
  const edge = rendered.length;
  await render({ isRecording: true, isArming: false });
  assert.deepEqual(rendered.slice(edge), ["idle", "thinking"]);
  await unmount();
});
