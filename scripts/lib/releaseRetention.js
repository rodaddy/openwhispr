const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(tag) {
  const match = VERSION_TAG.exec(tag);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersionDesc(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a.version[i] !== b.version[i]) return b.version[i] - a.version[i];
  }
  return 0;
}

/**
 * Pick which releases to keep and which to drop.
 * Keeps the newest build plus the builds before it, up to `keep`; a build
 * superseded by a newer build on the same calendar day (in `timeZone`) goes
 * at once. Non-version tags are dropped. `current` is never dropped.
 * @param {Array<{tag: string, createdAt: string}>} releases
 * @param {{keep?: number, timeZone?: string, current?: string|null}} [options]
 * @returns {{keep: string[], drop: string[]}} tags, newest first
 */
function selectRetention(
  releases,
  { keep = 3, timeZone = "America/New_York", current = null } = {}
) {
  const dayFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const seen = new Set();
  const versioned = [];
  const other = [];
  for (const release of releases) {
    if (seen.has(release.tag)) continue;
    seen.add(release.tag);
    const version = parseVersion(release.tag);
    if (!version) {
      other.push(release.tag);
      continue;
    }
    const time = new Date(release.createdAt);
    if (Number.isNaN(time.getTime())) {
      throw new Error(`Invalid createdAt for ${release.tag}: ${release.createdAt}`);
    }
    versioned.push({ tag: release.tag, version, day: dayFormat.format(time) });
  }

  versioned.sort(compareVersionDesc);

  const days = new Set();
  const survivors = [];
  const drop = [];
  for (const release of versioned) {
    if (days.has(release.day)) {
      drop.push(release);
    } else {
      days.add(release.day);
      survivors.push(release);
    }
  }

  const kept = survivors.slice(0, keep);
  drop.push(...survivors.slice(keep));
  drop.sort(compareVersionDesc);

  const keepTags = kept.map((release) => release.tag);
  let dropTags = drop.map((release) => release.tag).concat(other);

  if (current !== null && seen.has(current) && !keepTags.includes(current)) {
    dropTags = dropTags.filter((tag) => tag !== current);
    const currentRelease = versioned.find((release) => release.tag === current);
    if (currentRelease) {
      kept.push(currentRelease);
      kept.sort(compareVersionDesc);
      return { keep: kept.map((release) => release.tag), drop: dropTags };
    }
    keepTags.push(current);
  }

  return { keep: keepTags, drop: dropTags };
}

module.exports = { selectRetention };
