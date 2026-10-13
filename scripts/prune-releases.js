#!/usr/bin/env node
// Prune old builds (#544): keep the current build plus two, drop the rest.
// A dropped build goes entirely: its Forge release entry with its assets, and
// its folder in the runner's artifacts dir. Git tags stay (Forgejo's release
// DELETE keeps the tag).
//
//   node scripts/prune-releases.js --repo <owner/repo> --current <tag> \
//     [--artifacts <dir>] [--apply]
//
// Token from RELEASE_TOKEN; server from GITHUB_SERVER_URL. Without --apply it
// only prints what it would do.

const fs = require("fs");
const path = require("path");
const { selectRetention } = require("./lib/releaseRetention");

/**
 * Pick the artifact entries to remove: everything that is not the dir of a
 * kept version tag and not the dir of the current build (named the way
 * mac-build names it, `/` replaced by `-`).
 * @param {string[]} entries names in the artifacts dir
 * @param {string[]} keepTags tags the retention keeps
 * @param {string|null} current the ref being built
 * @returns {string[]} entry names to remove
 */
function artifactDirsToDrop(entries, keepTags, current) {
  const keep = new Set(keepTags.filter((tag) => /^v/.test(tag)));
  const currentDir = current ? current.replace(/\//g, "-") : null;
  return entries.filter((name) => !keep.has(name) && name !== currentDir);
}

function parseArgs(argv) {
  const args = { repo: null, current: null, artifacts: null, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--repo") args.repo = argv[++i];
    else if (arg === "--current") args.current = argv[++i];
    else if (arg === "--artifacts") args.artifacts = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.repo) throw new Error("--repo is required");
  if (!args.current) throw new Error("--current is required");
  return args;
}

async function listReleases(api, token) {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const res = await fetch(`${api}/releases?limit=50&page=${page}`, {
      headers: { Authorization: `token ${token}` },
    });
    if (!res.ok) throw new Error(`listing releases page ${page}: HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(`listing releases page ${page}: not an array`);
    if (body.length === 0) return releases;
    for (const r of body) releases.push({ tag: r.tag_name, createdAt: r.created_at, id: r.id });
  }
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`prune-releases: ${err.message}\n`);
    return 2;
  }
  const token = process.env.RELEASE_TOKEN;
  if (!token) {
    process.stderr.write("prune-releases: RELEASE_TOKEN is not set\n");
    return 2;
  }
  if (!process.env.GITHUB_SERVER_URL) {
    process.stderr.write("prune-releases: GITHUB_SERVER_URL is not set\n");
    return 2;
  }
  const server = process.env.GITHUB_SERVER_URL.replace(/\/+$/, "");
  const api = `${server}/api/v1/repos/${args.repo}`;

  let releases;
  try {
    releases = await listReleases(api, token);
  } catch (err) {
    process.stderr.write(`prune-releases: ${err.message}; nothing deleted\n`);
    return 1;
  }

  const selection = selectRetention(releases, { current: args.current });
  if (selection.keep.length === 0) {
    process.stderr.write("prune-releases: selection keeps nothing; nothing deleted\n");
    return 1;
  }

  const byTag = new Map(releases.map((r) => [r.tag, r]));
  for (const tag of selection.keep) console.log(`keep ${tag}`);
  const dropReleases = selection.drop.map((tag) => byTag.get(tag)).filter(Boolean);
  for (const r of dropReleases) console.log(`drop ${r.tag} release ${r.id}`);

  let dropDirs = [];
  let artifactsRoot = null;
  if (args.artifacts) {
    artifactsRoot = path.resolve(args.artifacts);
    const entries = fs.existsSync(artifactsRoot) ? fs.readdirSync(artifactsRoot) : [];
    dropDirs = artifactDirsToDrop(entries, selection.keep, args.current)
      .map((name) => path.join(artifactsRoot, name))
      .filter((p) => isInside(artifactsRoot, p));
    for (const p of dropDirs) console.log(`drop-dir ${p}`);
  }

  if (!args.apply) {
    console.log("dry run: nothing deleted (pass --apply to delete)");
    return 0;
  }

  let failed = false;
  for (const r of dropReleases) {
    try {
      const res = await fetch(`${api}/releases/${r.id}`, {
        method: "DELETE",
        headers: { Authorization: `token ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.log(`deleted release ${r.id} (${r.tag})`);
    } catch (err) {
      failed = true;
      process.stderr.write(
        `prune-releases: delete release ${r.id} (${r.tag}) failed: ${err.message}\n`
      );
    }
  }
  for (const p of dropDirs) {
    if (!isInside(artifactsRoot, p)) continue;
    try {
      fs.rmSync(p, { recursive: true, force: true });
      console.log(`removed ${p}`);
    } catch (err) {
      failed = true;
      process.stderr.write(`prune-releases: remove ${p} failed: ${err.message}\n`);
    }
  }
  return failed ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`prune-releases: ${err.stack || err.message}\n`);
      process.exit(1);
    }
  );
}

module.exports = { artifactDirsToDrop, main };
