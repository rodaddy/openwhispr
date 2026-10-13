const debugLogger = require("./debugLogger");
const { getMeetingJoinUrl } = require("./meetingJoinUrl");
const {
  DEFAULT_GRILL_EVENT_PREFIXES,
  normalizeGrillEventPrefixes,
  parseGrillEvent,
} = require("./grillCalendarEvent");

const MEETING_REMINDER_LEAD_MS = 60 * 1000;

function notificationKey(event) {
  return `${event.provider || "google"}:${event.id}`;
}

// A solo event with no invitees and no meeting link is a time block (focus
// time, a personal reminder), not a meeting — every provider syncs those.
// A block titled with a grill prefix is the exception: it prompts a grill.
function isReminderEligible(event, grillPrefixes) {
  return (
    event.attendees_count > 0 ||
    getMeetingJoinUrl(event) ||
    parseGrillEvent(event, grillPrefixes) !== null
  );
}

// Provider-agnostic meeting reminder scheduling. Reads only the shared
// calendar_events table (deduped across providers), so a single scheduler
// serves both calendar managers without double-firing reminders.
class CalendarReminderScheduler {
  constructor(databaseManager) {
    this.databaseManager = databaseManager;
    this.nextMeetingTimer = null;
    this.meetingEndTimer = null;
    this.activeMeeting = null;
    this.notifiedMeetings = new Set();
    this.grillEventPrefixes = [...DEFAULT_GRILL_EVENT_PREFIXES];
  }

  setGrillEventPrefixes(prefixes) {
    this.grillEventPrefixes = normalizeGrillEventPrefixes(prefixes);
    this.scheduleNextMeeting();
  }

  scheduleNextMeeting() {
    this._reconcileRecordingMeeting();
    if (this.nextMeetingTimer) {
      clearTimeout(this.nextMeetingTimer);
      this.nextMeetingTimer = null;
    }

    const upcoming = this.databaseManager.getUpcomingEvents(1440);
    const next = upcoming.find(
      (event) =>
        isReminderEligible(event, this.grillEventPrefixes) &&
        !this.notifiedMeetings.has(notificationKey(event))
    );
    if (!next) return;

    const delay = new Date(next.start_time).getTime() - MEETING_REMINDER_LEAD_MS - Date.now();
    if (delay <= 0) {
      this.onMeetingStart(next);
      return;
    }

    this.nextMeetingTimer = setTimeout(() => {
      this.onMeetingStart(next);
    }, delay);
  }

  onMeetingStart(event) {
    if (!isReminderEligible(event, this.grillEventPrefixes)) {
      this.scheduleNextMeeting();
      return;
    }

    const events = this.databaseManager.getActiveEvents();
    const stillExists =
      events.some((e) => notificationKey(e) === notificationKey(event)) ||
      this.databaseManager
        .getUpcomingEvents(1)
        .some((e) => notificationKey(e) === notificationKey(event));

    if (!stillExists) {
      this.scheduleNextMeeting();
      return;
    }

    // A grill block is not a meeting: it never becomes the active meeting, so
    // it brings no calendar-end offer or meeting context. With no active
    // meeting to gate it, a wake inside the block checks notifiedMeetings.
    const grill = parseGrillEvent(event, this.grillEventPrefixes);
    if (grill) {
      if (!this.notifiedMeetings.has(notificationKey(event))) {
        this.notifiedMeetings.add(notificationKey(event));
        debugLogger.info(
          "Calendar grill reminder due",
          { summary: event.summary, ...grill },
          "calendar"
        );
        this.meetingDetectionEngine?.handleGrillReminder?.(event, grill);
      }
      this.scheduleNextMeeting();
      return;
    }

    this.activeMeeting = event;
    this.notifiedMeetings.add(notificationKey(event));

    debugLogger.info("Calendar meeting reminder due", { summary: event.summary }, "calendar");
    this.meetingDetectionEngine?.handleCalendarReminder(event);

    this._scheduleMeetingEnd(event);

    this.scheduleNextMeeting();
  }

  onMeetingEnd() {
    debugLogger.info(
      "Calendar meeting ended",
      { summary: this.activeMeeting?.summary },
      "calendar"
    );
    if (this.activeMeeting) {
      this.meetingDetectionEngine?.handleCalendarMeetingEnd?.(this.activeMeeting);
    }
    this.activeMeeting = null;
    this._clearMeetingEndTimer();
    this.scheduleNextMeeting();
  }

  onWakeFromSleep() {
    const activeEvents = this.databaseManager.getActiveEvents();
    if (activeEvents.length > 0 && !this.activeMeeting) {
      this.onMeetingStart(activeEvents[0]);
    }
    this.scheduleNextMeeting();
  }

  getActiveMeetingState() {
    return {
      activeMeeting: this.activeMeeting,
      activeEvents: this.databaseManager.getActiveEvents(),
      upcomingEvents: this.databaseManager.getUpcomingEvents(15),
    };
  }

  // Refresh or clear the cached active event after a provider replaces its
  // rows. Keep notifiedMeetings intact so periodic snapshots cannot re-fire a
  // reminder that was already delivered.
  reconcileProvider(provider) {
    this._reconcileRecordingMeeting(provider);
    if (!this.activeMeeting || this.activeMeeting.provider !== provider) return;

    const key = notificationKey(this.activeMeeting);
    const currentEvent = [
      ...this.databaseManager.getActiveEvents(),
      ...this.databaseManager.getUpcomingEvents(1),
    ].find((event) => notificationKey(event) === key);

    if (!currentEvent) {
      this.meetingDetectionEngine?.removeCalendarMeeting?.(this.activeMeeting);
      this.activeMeeting = null;
      this._clearMeetingEndTimer();
      return;
    }

    this.activeMeeting = currentEvent;
    this.meetingDetectionEngine?.updateCalendarMeeting?.(currentEvent);
    this._scheduleMeetingEnd(currentEvent);
  }

  _scheduleMeetingEnd(event) {
    this._clearMeetingEndTimer();
    const endDelay = new Date(event.end_time).getTime() - Date.now();
    if (endDelay > 0) {
      this.meetingEndTimer = setTimeout(() => {
        this.onMeetingEnd();
      }, endDelay);
    }
  }

  _reconcileRecordingMeeting(provider = null) {
    this.meetingDetectionEngine?.reconcileCalendarMeeting?.(provider, (eventId) =>
      this.databaseManager.getCalendarEventById?.(eventId)
    );
  }

  _clearMeetingEndTimer() {
    if (this.meetingEndTimer) {
      clearTimeout(this.meetingEndTimer);
      this.meetingEndTimer = null;
    }
  }

  stop() {
    if (this.nextMeetingTimer) {
      clearTimeout(this.nextMeetingTimer);
      this.nextMeetingTimer = null;
    }
    this._clearMeetingEndTimer();
    this.activeMeeting = null;
  }

  // Re-arm after one provider's data changes without forgetting reminders
  // already delivered by the other provider.
  reset(provider = null) {
    if (!provider) {
      this.stop();
      this.notifiedMeetings.clear();
      return;
    }

    this._reconcileRecordingMeeting(provider);

    if (this.nextMeetingTimer) {
      clearTimeout(this.nextMeetingTimer);
      this.nextMeetingTimer = null;
    }

    if (this.activeMeeting?.provider === provider) {
      this.activeMeeting = null;
      this._clearMeetingEndTimer();
    }

    const prefix = `${provider}:`;
    for (const key of this.notifiedMeetings) {
      if (key.startsWith(prefix)) this.notifiedMeetings.delete(key);
    }

    this.scheduleNextMeeting();
  }
}

module.exports = CalendarReminderScheduler;
