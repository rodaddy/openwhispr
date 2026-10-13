const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") {
    return {
      shell: { openExternal: async () => undefined },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const MeetingDetectionEngine = require("../../src/helpers/meetingDetectionEngine");
Module._load = originalLoad;

const {
  DEFAULT_GRILL_EVENT_PREFIXES,
  normalizeGrillEventPrefixes,
  parseGrillEvent,
} = require("../../src/helpers/grillCalendarEvent.js");
const {
  GRILL_START_CHANNEL,
  GRILL_SUBSCRIBE_CHANNEL,
  GRILL_UNSUBSCRIBE_CHANNEL,
  GRILL_PENDING_TTL_MS,
  createGrillStartChannel,
} = require("../../src/helpers/grillStartChannel.js");
const CalendarReminderScheduler = require("../../src/helpers/calendarReminderScheduler.js");
const { getNotificationTimeoutMs } = require("../../src/helpers/notificationTimer.js");

// --- parsing ---------------------------------------------------------------

test("default grill prefixes are Grill and Life Story", () => {
  assert.deepEqual([...DEFAULT_GRILL_EVENT_PREFIXES], ["Grill", "Life Story"]);
});

test("Grill at the start of the summary is a daily grill with no chapter", () => {
  assert.deepEqual(parseGrillEvent({ summary: "Grill" }), { kind: "daily", chapter: null });
  assert.deepEqual(parseGrillEvent({ summary: "grill: morning" }), {
    kind: "daily",
    chapter: null,
  });
  assert.deepEqual(parseGrillEvent({ summary: "  GRILL 3" }), { kind: "daily", chapter: null });
});

test("Life Story is a lifetime grill; a chapter number sets the chapter", () => {
  assert.deepEqual(parseGrillEvent({ summary: "Life Story 3" }), {
    kind: "lifetime",
    chapter: 3,
  });
  assert.deepEqual(parseGrillEvent({ summary: "life story: ch 7 - school" }), {
    kind: "lifetime",
    chapter: 7,
  });
  assert.deepEqual(parseGrillEvent({ summary: "Life Story #2" }), {
    kind: "lifetime",
    chapter: 2,
  });
});

test("Life Story without a number has a null chapter", () => {
  assert.deepEqual(parseGrillEvent({ summary: "Life Story" }), {
    kind: "lifetime",
    chapter: null,
  });
  assert.deepEqual(parseGrillEvent({ summary: "Life Story: growing up" }), {
    kind: "lifetime",
    chapter: null,
  });
});

test("the prefix must start the summary and end at a word boundary", () => {
  assert.equal(parseGrillEvent({ summary: "Team grill" }), null);
  assert.equal(parseGrillEvent({ summary: "Grilled cheese lunch" }), null);
  assert.equal(parseGrillEvent({ summary: "Life Storyboard review" }), null);
  assert.equal(parseGrillEvent({ summary: "" }), null);
  assert.equal(parseGrillEvent({}), null);
  assert.equal(parseGrillEvent(null), null);
});

test("custom prefixes replace the defaults; an empty list disables the trigger", () => {
  assert.deepEqual(parseGrillEvent({ summary: "Roast 2" }, ["Roast"]), {
    kind: "daily",
    chapter: null,
  });
  assert.equal(parseGrillEvent({ summary: "Grill" }, ["Roast"]), null);
  assert.equal(parseGrillEvent({ summary: "Grill" }, []), null);
});

test("normalizeGrillEventPrefixes trims, drops junk, and falls back to defaults for non-arrays", () => {
  assert.deepEqual(normalizeGrillEventPrefixes([" Grill ", "", 4, null, "Life Story"]), [
    "Grill",
    "Life Story",
  ]);
  assert.deepEqual(normalizeGrillEventPrefixes(undefined), ["Grill", "Life Story"]);
  assert.deepEqual(normalizeGrillEventPrefixes("Grill"), ["Grill", "Life Story"]);
  assert.deepEqual(normalizeGrillEventPrefixes([]), []);
});

// --- scheduler eligibility ---------------------------------------------------

function activeEvent(overrides) {
  const now = Date.now();
  return {
    id: "evt-1",
    provider: "google",
    summary: "Focus time",
    start_time: new Date(now - 1000).toISOString(),
    end_time: new Date(now + 60_000).toISOString(),
    attendees_count: 0,
    ...overrides,
  };
}

function schedulerFor(event) {
  const databaseManager = {
    getUpcomingEvents: () => [event],
    getActiveEvents: () => [event],
  };
  const scheduler = new CalendarReminderScheduler(databaseManager);
  const calls = { calendar: [], grill: [] };
  scheduler.meetingDetectionEngine = {
    handleCalendarReminder: (e) => calls.calendar.push(e),
    handleGrillReminder: (e, grill) => calls.grill.push({ event: e, grill }),
  };
  return { scheduler, calls };
}

test("a solo Grill block with no attendees and no link fires a grill reminder", () => {
  const event = activeEvent({ summary: "Grill" });
  const { scheduler, calls } = schedulerFor(event);

  scheduler.scheduleNextMeeting();

  assert.equal(calls.calendar.length, 0);
  assert.equal(calls.grill.length, 1);
  assert.deepEqual(calls.grill[0].grill, { kind: "daily", chapter: null });
  assert.equal(calls.grill[0].event.id, "evt-1");
  scheduler.stop();
});

test("a solo Life Story 4 block fires a lifetime grill reminder for chapter 4", () => {
  const event = activeEvent({ summary: "Life Story 4" });
  const { scheduler, calls } = schedulerFor(event);

  scheduler.scheduleNextMeeting();

  assert.deepEqual(calls.grill[0].grill, { kind: "lifetime", chapter: 4 });
  scheduler.stop();
});

test("a solo non-prefixed block is still ignored", () => {
  const event = activeEvent({ summary: "Focus time" });
  const { scheduler, calls } = schedulerFor(event);

  scheduler.scheduleNextMeeting();

  assert.equal(calls.calendar.length, 0);
  assert.equal(calls.grill.length, 0);
  scheduler.stop();
});

test("a non-prefixed event with attendees reminds exactly as before", () => {
  const event = activeEvent({ summary: "Weekly sync", attendees_count: 2 });
  const { scheduler, calls } = schedulerFor(event);

  scheduler.scheduleNextMeeting();

  assert.equal(calls.calendar.length, 1);
  assert.equal(calls.calendar[0], event);
  assert.equal(calls.grill.length, 0);
  assert.equal(scheduler.activeMeeting, event);
  scheduler.stop();
});

test("a grill reminder does not become the active meeting", () => {
  const event = activeEvent({ summary: "Grill" });
  const { scheduler } = schedulerFor(event);

  scheduler.scheduleNextMeeting();

  assert.equal(scheduler.activeMeeting, null);
  scheduler.stop();
});

test("setGrillEventPrefixes changes which solo blocks are eligible", () => {
  const event = activeEvent({ summary: "Grill" });
  const { scheduler, calls } = schedulerFor(event);

  scheduler.setGrillEventPrefixes([]);
  assert.equal(calls.grill.length, 0);

  scheduler.setGrillEventPrefixes(["grill"]);
  assert.equal(calls.grill.length, 1);
  scheduler.stop();
});

test("a grill prompt gets the calendar reminder timeout", () => {
  assert.equal(getNotificationTimeoutMs("grill"), getNotificationTimeoutMs("calendar"));
});

// --- IPC channel ---------------------------------------------------------------

function fakeWebContents() {
  const wc = new EventEmitter();
  wc.sent = [];
  wc.destroyed = false;
  wc.isDestroyed = () => wc.destroyed;
  wc.send = (channel, payload) => wc.sent.push({ channel, payload });
  return wc;
}

function fakeLogger() {
  const lines = [];
  return {
    lines,
    warn: (...args) => lines.push(["warn", ...args]),
    info: (...args) => lines.push(["info", ...args]),
  };
}

test("the channel is named grill:start", () => {
  assert.equal(GRILL_START_CHANNEL, "grill:start");
});

test("emit with no subscriber queues the payload, logs one line, and sends nothing", () => {
  const ipcMain = new EventEmitter();
  const logger = fakeLogger();
  const channel = createGrillStartChannel({ ipcMain, logger });

  const delivered = channel.emit({ kind: "daily", chapter: null, eventId: "evt-1" });

  assert.equal(delivered, "queued");
  assert.equal(logger.lines.length, 1);
  assert.equal(logger.lines[0][1], "grill:start queued until a window subscribes");
  assert.deepEqual(logger.lines[0][2], { kind: "daily", chapter: null, eventId: "evt-1" });
});

test("the pending TTL is two minutes", () => {
  assert.equal(GRILL_PENDING_TTL_MS, 120000);
});

test("an emit before any subscriber is delivered exactly once to the first subscriber", () => {
  const ipcMain = new EventEmitter();
  const logger = fakeLogger();
  let clock = 1000;
  const channel = createGrillStartChannel({ ipcMain, logger, now: () => clock });
  const payload = { kind: "lifetime", chapter: 2, eventId: "evt-new-window" };

  assert.equal(channel.emit(payload), "queued");
  clock += 5000;
  const first = fakeWebContents();
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: first });

  assert.deepEqual(first.sent, [{ channel: "grill:start", payload }]);
  assert.equal(logger.lines.at(-1)[1], "grill:start delivered after subscribe");

  // The same renderer subscribing again, and a second renderer, get nothing.
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: first });
  const second = fakeWebContents();
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: second });
  assert.equal(first.sent.length, 1);
  assert.equal(second.sent.length, 0);
});

test("a pending grill:start older than the TTL is dropped with a log line", () => {
  const ipcMain = new EventEmitter();
  const logger = fakeLogger();
  let clock = 0;
  const channel = createGrillStartChannel({ ipcMain, logger, now: () => clock });

  channel.emit({ kind: "daily", chapter: null, eventId: "evt-old" });
  clock += GRILL_PENDING_TTL_MS + 1000;
  const wc = fakeWebContents();
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: wc });

  assert.equal(wc.sent.length, 0);
  const expired = logger.lines.at(-1);
  assert.equal(expired[1], "grill:start expired before a window subscribed");
  assert.equal(expired[2].ageSeconds, 121);

  // Cleared: a later subscriber gets nothing either.
  const later = fakeWebContents();
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: later });
  assert.equal(later.sent.length, 0);
});

test("the latest queued emit replaces an older pending one", () => {
  const ipcMain = new EventEmitter();
  let clock = 0;
  const channel = createGrillStartChannel({ ipcMain, logger: fakeLogger(), now: () => clock });

  channel.emit({ kind: "daily", chapter: null, eventId: "evt-1" });
  clock += 1000;
  channel.emit({ kind: "lifetime", chapter: 4, eventId: "evt-2" });
  const wc = fakeWebContents();
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: wc });

  assert.deepEqual(wc.sent, [
    { channel: "grill:start", payload: { kind: "lifetime", chapter: 4, eventId: "evt-2" } },
  ]);
});

test("a live subscriber still gets grill:start immediately and nothing is queued", () => {
  const ipcMain = new EventEmitter();
  const channel = createGrillStartChannel({ ipcMain, logger: fakeLogger() });
  const wc = fakeWebContents();
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: wc });

  assert.equal(channel.emit({ kind: "daily", chapter: null, eventId: "e" }), "sent");
  assert.equal(wc.sent.length, 1);

  const other = fakeWebContents();
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: other });
  assert.equal(other.sent.length, 0);
});

test("emit delivers {kind, chapter, eventId} to a subscribed renderer", () => {
  const ipcMain = new EventEmitter();
  const logger = fakeLogger();
  const channel = createGrillStartChannel({ ipcMain, logger });
  const wc = fakeWebContents();
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: wc });

  const delivered = channel.emit({ kind: "lifetime", chapter: 3, eventId: "evt-9", extra: 1 });

  assert.equal(delivered, "sent");
  assert.deepEqual(wc.sent, [
    { channel: "grill:start", payload: { kind: "lifetime", chapter: 3, eventId: "evt-9" } },
  ]);
  assert.equal(logger.lines.length, 0);
});

test("unsubscribed and destroyed renderers stop counting as handlers", () => {
  const ipcMain = new EventEmitter();
  const logger = fakeLogger();
  const channel = createGrillStartChannel({ ipcMain, logger });
  const a = fakeWebContents();
  const b = fakeWebContents();
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: a });
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: b });
  ipcMain.emit(GRILL_UNSUBSCRIBE_CHANNEL, { sender: a });
  b.destroyed = true;
  b.emit("destroyed");

  assert.equal(channel.emit({ kind: "daily", chapter: null, eventId: "e" }), "queued");
  assert.equal(a.sent.length, 0);
  assert.equal(b.sent.length, 0);
});

// --- engine: prompt and response ---------------------------------------------

class FakeDetector extends EventEmitter {
  start() {}
  stop() {}
  getDetectedProcesses() {
    return [];
  }
  getExternalMicState() {
    return { reliable: true, externalMicActive: false };
  }
  setUserRecording() {}
  resetPrompt() {}
  dismiss() {}
}

function createEngine() {
  const shown = [];
  let dismissed = 0;
  const emitted = [];
  const databaseManager = {
    saveNote: () => {
      throw new Error("a grill must not create a meeting note");
    },
  };
  const engine = new MeetingDetectionEngine(
    { getActiveMeetingState: () => ({ activeMeeting: null, upcomingEvents: [] }) },
    new FakeDetector(),
    new FakeDetector(),
    {
      notificationPrefs: {},
      showMeetingNotification: (n) => shown.push(n),
      dismissMeetingNotification: () => {
        dismissed += 1;
      },
    },
    databaseManager,
    { grillStartChannel: { emit: (payload) => emitted.push(payload) } }
  );
  return { engine, shown, emitted, dismissedCount: () => dismissed };
}

test("a grill reminder shows a grill detection prompt", () => {
  const { engine, shown } = createEngine();
  const event = activeEvent({ id: "evt-7", summary: "Life Story 2" });

  engine.handleGrillReminder(event, { kind: "lifetime", chapter: 2 });

  assert.equal(shown.length, 1);
  assert.equal(shown[0].kind, "detection");
  assert.equal(shown[0].source, "grill");
  assert.equal(shown[0].detectionId, "grill:evt-7");
  assert.deepEqual(shown[0].grill, { kind: "lifetime", chapter: 2 });
  assert.equal(shown[0].joinUrl, null);
});

test("Start grill emits one grill:start payload and never starts a meeting", async () => {
  const { engine, shown, emitted, dismissedCount } = createEngine();
  const event = activeEvent({ id: "evt-7", summary: "Life Story 2" });
  engine.handleGrillReminder(event, { kind: "lifetime", chapter: 2 });

  await engine.handleNotificationResponse(shown[0].detectionId, "start-grill");

  assert.deepEqual(emitted, [{ kind: "lifetime", chapter: 2, eventId: "evt-7" }]);
  assert.equal(engine._meetingModeActive, false);
  assert.equal(engine.activeDetections.size, 0);
  assert.equal(dismissedCount(), 1);
});

test("a start or join response to a grill prompt does not start a meeting", async () => {
  const { engine, shown, emitted } = createEngine();
  engine.handleGrillReminder(activeEvent({ id: "evt-8", summary: "Grill" }), {
    kind: "daily",
    chapter: null,
  });

  await engine.handleNotificationResponse(shown[0].detectionId, "start");

  assert.equal(engine._meetingModeActive, false);
  assert.deepEqual(emitted, []);
});

test("grill prompts respect the calendar reminder notification toggle", () => {
  const { engine, shown } = createEngine();
  engine.windowManager.notificationPrefs = { notifyCalendarReminders: false };

  engine.handleGrillReminder(activeEvent({ summary: "Grill" }), { kind: "daily", chapter: null });

  assert.equal(shown.length, 0);
});

test("waking inside an already-prompted grill block does not prompt again", () => {
  const event = activeEvent({ summary: "Grill" });
  const { scheduler, calls } = schedulerFor(event);

  scheduler.scheduleNextMeeting();
  scheduler.onWakeFromSleep();

  assert.equal(calls.grill.length, 1);
  scheduler.stop();
});

// --- subscriber lifetime -------------------------------------------------------

const LIFETIME_EVENTS = ["did-start-navigation", "render-process-gone", "destroyed"];

function liveListenerCount(wc) {
  return LIFETIME_EVENTS.reduce((sum, name) => sum + wc.listenerCount(name), 0);
}

test("a main-frame reload drops the subscriber until the renderer re-subscribes", () => {
  const ipcMain = new EventEmitter();
  const logger = fakeLogger();
  const channel = createGrillStartChannel({ ipcMain, logger });
  const wc = fakeWebContents();
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: wc });

  wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });

  assert.equal(channel.emit({ kind: "daily", chapter: null, eventId: "e" }), "queued");
  assert.equal(wc.sent.length, 0);
  assert.equal(liveListenerCount(wc), 0);

  // Re-subscribing after the reload delivers the queued start once.
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: wc });
  assert.equal(wc.sent.length, 1);
  assert.equal(channel.emit({ kind: "daily", chapter: null, eventId: "e" }), "sent");
  assert.equal(wc.sent.length, 2);
  assert.equal(liveListenerCount(wc), 3);
});

test("a reload reported through the deprecated positional arguments also drops", () => {
  const ipcMain = new EventEmitter();
  const channel = createGrillStartChannel({ ipcMain, logger: fakeLogger() });
  const wc = fakeWebContents();
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: wc });

  wc.emit("did-start-navigation", {}, "app://index.html", false, true);

  assert.equal(channel.emit({ kind: "daily", chapter: null, eventId: "e" }), "queued");
});

test("in-page and subframe navigation keep the subscriber", () => {
  const ipcMain = new EventEmitter();
  const channel = createGrillStartChannel({ ipcMain, logger: fakeLogger() });
  const wc = fakeWebContents();
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: wc });

  wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  wc.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });

  assert.equal(channel.emit({ kind: "daily", chapter: null, eventId: "e" }), "sent");
});

test("a render process crash drops the subscriber and releases its listeners", () => {
  const ipcMain = new EventEmitter();
  const logger = fakeLogger();
  const channel = createGrillStartChannel({ ipcMain, logger });
  const wc = fakeWebContents();
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: wc });

  wc.emit("render-process-gone", {}, { reason: "crashed" });

  assert.equal(channel.emit({ kind: "lifetime", chapter: 1, eventId: "e" }), "queued");
  assert.equal(wc.sent.length, 0);
  assert.equal(liveListenerCount(wc), 0);
  assert.equal(logger.lines.length, 1);
});

test("an emit with no live subscriber logs exactly one line per emit and sends nothing", () => {
  const ipcMain = new EventEmitter();
  const logger = fakeLogger();
  const channel = createGrillStartChannel({ ipcMain, logger });
  const wc = fakeWebContents();
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: wc });
  wc.destroyed = true; // destroyed without the event having fired yet

  assert.equal(channel.emit({ kind: "daily", chapter: null, eventId: "e" }), "queued");
  assert.equal(wc.sent.length, 0);
  assert.equal(logger.lines.length, 1);
  assert.equal(logger.lines[0][0], "warn");
});

test("repeat subscribes from one renderer do not stack lifetime listeners", () => {
  const ipcMain = new EventEmitter();
  createGrillStartChannel({ ipcMain, logger: fakeLogger() });
  const wc = fakeWebContents();
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: wc });
  ipcMain.emit(GRILL_SUBSCRIBE_CHANNEL, { sender: wc });

  assert.equal(liveListenerCount(wc), 3);

  ipcMain.emit(GRILL_UNSUBSCRIBE_CHANNEL, { sender: wc });
  assert.equal(liveListenerCount(wc), 3);
  ipcMain.emit(GRILL_UNSUBSCRIBE_CHANNEL, { sender: wc });
  assert.equal(liveListenerCount(wc), 0);
});

test("Start grill shows and focuses the control panel before emitting grill:start", async () => {
  const order = [];
  const engine = new MeetingDetectionEngine(
    { getActiveMeetingState: () => ({ activeMeeting: null, upcomingEvents: [] }) },
    new FakeDetector(),
    new FakeDetector(),
    {
      notificationPrefs: {},
      showMeetingNotification: (n) => order.push(["prompt", n.detectionId]),
      dismissMeetingNotification: () => {},
      createControlPanelWindow: async () => {
        order.push(["show-control-panel:start"]);
        await new Promise((resolve) => setImmediate(resolve));
        order.push(["show-control-panel:done"]);
      },
    },
    {},
    { grillStartChannel: { emit: (payload) => order.push(["emit", payload.kind]) } }
  );
  engine.handleGrillReminder(activeEvent({ id: "evt-9", summary: "Grill" }), {
    kind: "daily",
    chapter: null,
  });
  await engine.handleNotificationResponse("grill:evt-9", "start-grill");
  assert.deepEqual(order.slice(1), [
    ["show-control-panel:start"],
    ["show-control-panel:done"],
    ["emit", "daily"],
  ]);
});

test("a control panel that cannot be shown still gets grill:start emitted", async () => {
  const emitted = [];
  const engine = new MeetingDetectionEngine(
    { getActiveMeetingState: () => ({ activeMeeting: null, upcomingEvents: [] }) },
    new FakeDetector(),
    new FakeDetector(),
    {
      notificationPrefs: {},
      showMeetingNotification: () => {},
      dismissMeetingNotification: () => {},
      createControlPanelWindow: async () => {
        throw new Error("window gone");
      },
    },
    {},
    { grillStartChannel: { emit: (payload) => emitted.push(payload.kind) } }
  );
  engine.handleGrillReminder(activeEvent({ id: "evt-10", summary: "Grill" }), {
    kind: "daily",
    chapter: null,
  });
  await engine.handleNotificationResponse("grill:evt-10", "start-grill");
  assert.deepEqual(emitted, ["daily"]);
});
