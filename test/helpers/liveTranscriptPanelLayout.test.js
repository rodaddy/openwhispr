const test = require("node:test");
const assert = require("node:assert/strict");
const { renderStatic } = require("./harness/reactSsr");

test("fixed preview renders exactly two text lines in a fixed scrolling region", async () => {
  const { FIXED_TRANSCRIPT_VIEWPORT_PX, LiveTranscriptPanel, TRANSCRIPT_LINE_HEIGHT_PX } =
    await import("../../src/components/dictation/LiveTranscriptPanel.tsx");
  const markup = renderStatic(LiveTranscriptPanel, {
    text: "one two three four five six seven eight nine ten",
    measurementText: "one two three four five six seven eight nine ten",
    phase: "live",
    processing: false,
    controlsVisible: true,
    contentVisible: true,
    onCollapse: () => {},
    layout: "fixed2lines",
  });
  assert.match(markup, /h-\[6rem\] flex-none/);
  assert.match(markup, /style="height:52px" data-transcript-scroll-viewport="true"/);
  assert.match(markup, /min-h-\[3\.25rem\][^>]*style="line-height:26px"/);
  assert.doesNotMatch(markup, /min-h-\[4\.875rem\]/);

  const clipTop = 32;
  const clipBottom = clipTop + FIXED_TRANSCRIPT_VIEWPORT_PX;
  const longTextBottom = clipTop + TRANSCRIPT_LINE_HEIGHT_PX * 5;
  const visibleTextIntersection = Math.max(
    0,
    Math.min(longTextBottom, clipBottom) - Math.max(clipTop, clipTop)
  );
  assert.ok(visibleTextIntersection >= TRANSCRIPT_LINE_HEIGHT_PX);
  assert.equal(visibleTextIntersection, TRANSCRIPT_LINE_HEIGHT_PX * 2);
  assert.ok(longTextBottom - clipTop > FIXED_TRANSCRIPT_VIEWPORT_PX);
});
