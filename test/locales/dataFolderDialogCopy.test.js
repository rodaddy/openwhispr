const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { SUPPORTED_UI_LANGUAGES } = require("../../src/helpers/i18nMain");

const LOCALES_DIR = path.join(__dirname, "..", "..", "src", "locales");

function flatten(obj, prefix = "") {
  return Object.entries(obj).reduce((out, [key, value]) => {
    const next = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === "object"
      ? { ...out, ...flatten(value, next) }
      : { ...out, [next]: value };
  }, {});
}

function dialogStrings(lang) {
  const file = path.join(LOCALES_DIR, lang, "translation.json");
  return flatten(JSON.parse(fs.readFileSync(file, "utf8")).dataFolderDialog || {});
}

test("the blocked-boot data folder dialog is translated in all 10 locales", () => {
  const en = dialogStrings("en");
  const keys = Object.keys(en);
  assert.equal(SUPPORTED_UI_LANGUAGES.length, 10);
  assert.ok(keys.includes("reason.missing"));
  assert.ok(keys.includes("reason.notWritable"));
  assert.ok(keys.includes("reason.noMarker"));

  for (const lang of SUPPORTED_UI_LANGUAGES) {
    const strings = dialogStrings(lang);
    assert.deepEqual(Object.keys(strings).sort(), [...keys].sort(), `${lang} key set`);
    for (const key of keys) {
      assert.equal(typeof strings[key], "string", `${lang}: ${key}`);
      assert.ok(strings[key].trim(), `${lang}: ${key} is empty`);
      if (lang !== "en") {
        assert.notEqual(strings[key], en[key], `${lang}: ${key} is untranslated`);
      }
    }
  }
});

test("the no-marker refusal no longer says moving is not available yet (#257)", () => {
  for (const lang of SUPPORTED_UI_LANGUAGES) {
    const text = dialogStrings(lang)["refused.noMarker"];
    assert.ok(!text.includes("not available yet"), `${lang}: refused.noMarker is stale`);
  }
});
