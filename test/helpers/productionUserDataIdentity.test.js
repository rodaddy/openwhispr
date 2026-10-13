const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  channelDefaultUserData,
  resolveBootDataRoot,
  applyBootDataRoot,
} = require("../../src/helpers/dataRootBootstrap");

// With no pointer and no env override, boot must land on the same profile
// folder as before #257; --user-data-dir now wins in every channel.
for (const [channel, override, expected] of [
  ["production", false, "open-whispr"],
  ["production", true, "explicit-profile"],
  ["development", false, "OpenWhispr-development"],
  ["development", true, "explicit-profile"],
]) {
  test(`${channel} startup preserves the intended profile (override=${override})`, (t) => {
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-profile-"));
    t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
    let profile = path.join(appData, override ? "explicit-profile" : "rTech Whisper");
    const app = {
      getPath: () => profile,
      setPath: (name, value) => {
        assert.equal(name, "userData");
        profile = value;
      },
    };

    const resolution = resolveBootDataRoot({
      defaultUserData: channelDefaultUserData(appData, channel),
      channel,
      hasUserDataDirSwitch: override,
    });
    applyBootDataRoot(app, resolution, {});

    assert.equal(profile, path.join(appData, expected));
  });
}
