// Delta cursors belong to one hub (rtech-whisper#126, decision D14). A hub
// switch relaunches the app; the first hub-mode read after that moves the old
// hub's cursors (and the D12 cursorVersion marker) aside and brings back the
// new hub's, or none, which makes the first pass a full snapshot.

const HUB_URL_KEY = "sync.hubUrl";
const STASH_PREFIX = "hubCursors.";

// An unreadable stash is no stash: the hub gets a full snapshot.
function readStash(store: Storage, url: string): Record<string, string> {
  try {
    const parsed = JSON.parse(store.getItem(STASH_PREFIX + url) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isCursorKey(key: string): boolean {
  return key.startsWith("lastSyncedAt") || key === "sync.cursorVersion";
}

/** url is the normalized current hub URL. Returns true when it swapped. */
export function swapHubCursors(url: string, store: Storage = localStorage): boolean {
  if (!url) return false;
  const previous = store.getItem(HUB_URL_KEY);
  if (previous === url) return false;
  if (previous !== null) {
    const stash: Record<string, string> = {};
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && isCursorKey(key)) keys.push(key);
    }
    for (const key of keys) {
      stash[key] = store.getItem(key) ?? "";
      store.removeItem(key);
    }
    store.setItem(STASH_PREFIX + previous, JSON.stringify(stash));
    for (const [key, value] of Object.entries(readStash(store, url))) store.setItem(key, value);
    store.removeItem(STASH_PREFIX + url);
  }
  // First run after the upgrade (no marker): the stored cursors are this hub's.
  store.setItem(HUB_URL_KEY, url);
  return previous !== null;
}
