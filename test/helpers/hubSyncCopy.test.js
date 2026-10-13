// The hub sync settings copy must match the behavior (review of #107-#118):
// with the URL prefilled to the default hub, saving a device key alone turns
// hub sync on and starts a full upload, so the copy must not say otherwise.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const localesDir = path.join(__dirname, "../../src/locales");

for (const locale of fs.readdirSync(localesDir)) {
  const file = path.join(localesDir, locale, "translation.json");
  if (!fs.existsSync(file)) continue;
  const hubSync = JSON.parse(fs.readFileSync(file, "utf8")).settingsPage?.hubSync;
  if (!hubSync) continue;

  test(`${locale}: hub sync copy says saving the key turns sync on`, () => {
    assert.doesNotMatch(hubSync.description, /does not turn sync on/i);
    assert.doesNotMatch(hubSync.urlHint, /leave empty/i);
    if (locale === "en") {
      assert.match(hubSync.description, /device key turns sync on/i);
      assert.match(hubSync.urlHint, /turn sync off/i);
    }
  });
}
