// Grill mode's day questions read selected-calendar events across every
// connected provider in a local window (today and yesterday). Read-only. A
// failed read is logged and reported, never swallowed: the renderer then opens
// the session with a visible note instead of silently skipping day questions.
const GRILL_CALENDAR_PROVIDERS = ["google", "microsoft", "apple"];

function getGrillCalendarEvents(databaseManager, start, end, logger) {
  try {
    return {
      success: true,
      events: databaseManager.getCalendarEventsInRange(start, end, GRILL_CALENDAR_PROVIDERS),
    };
  } catch (error) {
    const message = error?.message || String(error);
    logger.error("Grill calendar read failed", { error: message, start, end }, "grill");
    return { success: false, events: [], error: message };
  }
}

module.exports = { getGrillCalendarEvents };
