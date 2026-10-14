// "Sync now" from Settings > Integrations: re-read the calendar list,
// then the events, and hand the first failure back to the caller. The periodic
// path only logs these failures; this path is the one that returns them.

// fetchCalendars(errors) pushes each per-account failure onto `errors`;
// syncEvents() resolves to [[accountEmail, error | null], ...] or undefined.
async function runCalendarSyncNow({ fetchCalendars, syncEvents }) {
  try {
    const errors = [];
    await fetchCalendars(errors);
    const results = (await syncEvents()) || [];
    for (const [, err] of results) {
      if (err) errors.push(err);
    }
    if (errors.length > 0) {
      return { success: false, error: errors[0]?.message || String(errors[0]) };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
}

// A second call while one is running gets the running call's result.
function singleFlight(run) {
  let running = null;
  return () => {
    if (!running) {
      running = new Promise((resolve) => resolve(run())).finally(() => {
        running = null;
      });
    }
    return running;
  };
}

module.exports = { runCalendarSyncNow, singleFlight };
