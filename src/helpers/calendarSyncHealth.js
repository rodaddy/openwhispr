// Per-account calendar sync health: last successful sync and the
// current failure streak, so a broken sync is visible instead of only logged.
const AUTH_ERROR_PATTERN = /unauthorized|invalid_grant/i;

function classifySyncError(err) {
  if (err?.statusCode === 401 || err?.code === "invalid_grant") return "auth";
  return AUTH_ERROR_PATTERN.test(err?.message || "") ? "auth" : "other";
}

class CalendarSyncHealth {
  constructor() {
    this.accounts = new Map();
  }

  get(email) {
    return this.accounts.get(email) || { lastSuccessAt: null, failure: null };
  }

  snapshot() {
    return Object.fromEntries(
      [...this.accounts].map(([email, { lastSuccessAt, failure }]) => [
        email,
        { lastSuccessAt, failure },
      ])
    );
  }

  recordSuccess(email, now = Date.now()) {
    this.accounts.set(email, { lastSuccessAt: now, failure: null, notified: false });
  }

  // Returns { notify: true } only for the first auth failure of a streak.
  recordFailure(email, err, now = Date.now()) {
    const prev = this.get(email);
    const kind = classifySyncError(err);
    const since = prev.failure?.kind === kind ? prev.failure.since : now;
    const notify = kind === "auth" && !prev.notified;
    this.accounts.set(email, {
      lastSuccessAt: prev.lastSuccessAt,
      failure: { kind, since, message: err?.message || String(err) },
      notified: Boolean(prev.notified) || notify,
    });
    return { notify };
  }

  // results: [email, error|null] per synced calendar. An account fails the
  // pass if any of its calendars failed. Returns the emails to notify.
  recordSyncPass(results, now = Date.now()) {
    const byEmail = new Map();
    for (const [email, err] of results) {
      if (!email) continue;
      if (!byEmail.get(email)) byEmail.set(email, err || null);
    }
    const notify = [];
    for (const [email, err] of byEmail) {
      if (!err) this.recordSuccess(email, now);
      else if (this.recordFailure(email, err, now).notify) notify.push(email);
    }
    return notify;
  }

  remove(email) {
    if (email) this.accounts.delete(email);
    else this.accounts.clear();
  }
}

function showReconnectNotification(providerName) {
  const { Notification } = require("electron");
  if (!Notification.isSupported()) return;
  new Notification({
    title: `${providerName} needs to be reconnected`,
    body: `${providerName} needs to be reconnected -- meeting reminders may be out of date.`,
  }).show();
}

module.exports = { classifySyncError, CalendarSyncHealth, showReconnectNotification };
