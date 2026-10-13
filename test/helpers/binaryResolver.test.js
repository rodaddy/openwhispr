const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const debugLogger = require("../../src/helpers/debugLogger");
const { resolveBundledBinary, forgetBundledBinary } = require("../../src/helpers/binaryResolver");

function fakeResources(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "binary-resolver-"));
  // Electron's resourcesPath ignores plain assignment, so test:db needs defineProperty.
  const original = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: root });
  t.after(() => {
    if (original) {
      Object.defineProperty(process, "resourcesPath", original);
    } else {
      delete process.resourcesPath;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function spy(t) {
  const counts = { fs: 0, info: 0, paths: [] };
  const realExists = fs.existsSync;
  t.mock.method(fs, "existsSync", (candidate) => {
    counts.fs += 1;
    counts.paths.push(candidate);
    return realExists(candidate);
  });
  t.mock.method(debugLogger, "info", () => {
    counts.info += 1;
  });
  return counts;
}

test("a second resolve checks only the cached path and logs nothing", (t) => {
  const root = fakeResources(t);
  const name = `cached-helper-${process.pid}`;
  const binary = path.join(root, name);
  fs.writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
  t.after(() => forgetBundledBinary(name));

  const counts = spy(t);
  assert.equal(resolveBundledBinary(name, "audio"), binary);
  assert.equal(counts.info, 1);
  const fsAfterFirst = counts.fs;
  assert.ok(fsAfterFirst > 0);

  assert.equal(resolveBundledBinary(name, "audio"), binary);
  assert.deepEqual(counts.paths.slice(fsAfterFirst), [], "the cached resolve scans no candidates");
  assert.equal(counts.info, 1, "the cached resolve logs nothing");
});

test("a missing file is never cached and a forgotten entry re-resolves", (t) => {
  const root = fakeResources(t);
  const name = `missing-helper-${process.pid}`;
  const binary = path.join(root, name);
  t.after(() => forgetBundledBinary(name));

  assert.equal(resolveBundledBinary(name, "audio"), null);
  fs.writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(resolveBundledBinary(name, "audio"), binary, "a missing result is not cached");

  // The file stays executable, so only an explicit forget can force a rescan.
  const counts = spy(t);
  forgetBundledBinary(name);
  assert.equal(resolveBundledBinary(name, "audio"), binary);
  assert.equal(counts.info, 1, "a forgotten entry re-resolves");
});

test("a cached path that disappeared is dropped and a new candidate is found", (t) => {
  const root = fakeResources(t);
  const name = `moved-helper-${process.pid}`;
  const binary = path.join(root, name);
  fs.writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
  t.after(() => forgetBundledBinary(name));

  assert.equal(resolveBundledBinary(name, "audio"), binary);
  fs.rmSync(binary);
  assert.equal(resolveBundledBinary(name, "audio"), null, "the removed path is not returned");

  const moved = path.join(root, "bin", name);
  fs.mkdirSync(path.dirname(moved));
  fs.writeFileSync(moved, "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(resolveBundledBinary(name, "audio"), moved, "the new candidate is found");
});

test("a cached path that is no longer executable is dropped for an executable candidate", (t) => {
  const root = fakeResources(t);
  const name = `chmod-helper-${process.pid}`;
  const binary = path.join(root, name);
  fs.writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
  t.after(() => forgetBundledBinary(name));

  assert.equal(resolveBundledBinary(name, "audio"), binary);
  fs.chmodSync(binary, 0o644);
  assert.equal(
    resolveBundledBinary(name, "audio"),
    null,
    "the non-executable path is not returned"
  );

  const alternative = path.join(root, "bin", name);
  fs.mkdirSync(path.dirname(alternative));
  fs.writeFileSync(alternative, "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(
    resolveBundledBinary(name, "audio"),
    alternative,
    "the executable candidate is found"
  );
});
