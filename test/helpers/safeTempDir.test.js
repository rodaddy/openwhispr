const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { resolveSafeTempDir } = require("../../src/helpers/safeTempDir.js");

test("userData on darwin resolves to <userData>/tmp", () => {
  const dir = resolveSafeTempDir({
    userDataDir: "/mnt/Data/OpenWhispr",
    platform: "darwin",
    systemTemp: "/var/folders/x/T",
    env: {},
  });
  assert.equal(dir, path.join("/mnt/Data/OpenWhispr", "tmp"));
});

test("no userData resolves to the system temp", () => {
  for (const userDataDir of [null, undefined, ""]) {
    const dir = resolveSafeTempDir({
      userDataDir,
      platform: "darwin",
      systemTemp: "/var/folders/x/T",
      env: {},
    });
    assert.equal(dir, "/var/folders/x/T");
  }
});

test("win32 userData with a space falls back to ProgramData", () => {
  const dir = resolveSafeTempDir({
    userDataDir: "C:\\Users\\Jane Doe\\AppData\\Roaming\\OpenWhispr",
    platform: "win32",
    systemTemp: "C:\\Temp",
    env: { ProgramData: "C:\\ProgramData" },
  });
  assert.equal(dir, path.join("C:\\ProgramData", "OpenWhispr", "temp"));
});

test("win32 clean ASCII userData resolves to <userData>\\tmp", () => {
  const userDataDir = "D:\\OpenWhispr";
  const dir = resolveSafeTempDir({
    userDataDir,
    platform: "win32",
    systemTemp: "C:\\Temp",
    env: { ProgramData: "C:\\ProgramData" },
  });
  assert.equal(dir, path.join(userDataDir, "tmp"));
});
