const debugLogger = require("./debugLogger");

const GRILL_START_CHANNEL = "grill:start";
const GRILL_SUBSCRIBE_CHANNEL = "grill:subscribe";
const GRILL_UNSUBSCRIBE_CHANNEL = "grill:unsubscribe";
// How long a grill:start emitted with no subscriber waits for one.
const GRILL_PENDING_TTL_MS = 120000;

// A main-frame navigation that loads a new document (reload, navigate) wipes
// the renderer's listeners. Electron passes a details object; the positional
// (url, isInPlace, isMainFrame) arguments are the deprecated form.
function isDocumentReplacingNavigation(details, _url, isInPlace, isMainFrame) {
  const mainFrame = details?.isMainFrame ?? isMainFrame;
  const sameDocument = details?.isSameDocument ?? isInPlace;
  return mainFrame === true && sameDocument !== true;
}

// Main -> renderer "grill:start" event. A renderer that wants it subscribes
// (preload's onGrillStart does), so main can tell when nobody is listening.
// An emit with no live subscriber (the control panel window was just created
// and has not loaded yet) is held in a single pending slot, latest wins, and
// handed to the first renderer that subscribes within GRILL_PENDING_TTL_MS.
// A subscriber also ends when its webContents reloads, navigates, crashes, or
// is destroyed; the renderer subscribes again when its page loads.
function createGrillStartChannel({ ipcMain, logger = debugLogger, now = Date.now } = {}) {
  // webContents -> { count, release }
  const subscribers = new Map();
  // { payload, at } or null; delivered or expired at most once.
  let pending = null;

  const flushPending = (webContents) => {
    if (!pending) return;
    const { payload, at } = pending;
    pending = null;
    const ageMs = now() - at;
    if (ageMs > GRILL_PENDING_TTL_MS) {
      logger.warn(
        "grill:start expired before a window subscribed",
        { ...payload, ageSeconds: Math.round(ageMs / 1000) },
        "grill"
      );
      return;
    }
    webContents.send(GRILL_START_CHANNEL, payload);
    logger.info("grill:start delivered after subscribe", payload, "grill");
  };

  const drop = (webContents) => {
    const entry = subscribers.get(webContents);
    if (!entry) return;
    subscribers.delete(webContents);
    entry.release();
  };

  const track = (webContents) => {
    const onNavigate = (...args) => {
      if (isDocumentReplacingNavigation(...args)) drop(webContents);
    };
    const onGone = () => drop(webContents);
    webContents.on?.("did-start-navigation", onNavigate);
    webContents.on?.("render-process-gone", onGone);
    webContents.on?.("destroyed", onGone);
    return () => {
      webContents.removeListener?.("did-start-navigation", onNavigate);
      webContents.removeListener?.("render-process-gone", onGone);
      webContents.removeListener?.("destroyed", onGone);
    };
  };

  ipcMain?.on(GRILL_SUBSCRIBE_CHANNEL, (event) => {
    const webContents = event?.sender;
    if (!webContents) return;
    const entry = subscribers.get(webContents);
    if (entry) entry.count += 1;
    else subscribers.set(webContents, { count: 1, release: track(webContents) });
    flushPending(webContents);
  });

  ipcMain?.on(GRILL_UNSUBSCRIBE_CHANNEL, (event) => {
    const entry = subscribers.get(event?.sender);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count <= 0) drop(event.sender);
  });

  return {
    emit({ kind, chapter = null, eventId = null } = {}) {
      const payload = { kind, chapter, eventId };
      const live = [...subscribers.keys()].filter((webContents) => !webContents.isDestroyed?.());
      if (live.length === 0) {
        pending = { payload, at: now() };
        logger.warn("grill:start queued until a window subscribes", payload, "grill");
        return "queued";
      }
      for (const webContents of live) webContents.send(GRILL_START_CHANNEL, payload);
      return "sent";
    },
  };
}

module.exports = {
  GRILL_START_CHANNEL,
  GRILL_SUBSCRIBE_CHANNEL,
  GRILL_UNSUBSCRIBE_CHANNEL,
  GRILL_PENDING_TTL_MS,
  createGrillStartChannel,
};
