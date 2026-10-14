const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/autoLearnDefault.ts");

const memStorage = (init = {}) => {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
};

test("auto-learn defaults to OFF when nothing is stored", async () => {
  const { parseAutoLearn, AUTO_LEARN_DEFAULT } = await load();
  assert.equal(AUTO_LEARN_DEFAULT, false);
  assert.equal(parseAutoLearn(null), false);
  assert.equal(parseAutoLearn("true"), true);
  assert.equal(parseAutoLearn("false"), false);
});

test("migration switches an existing ON install OFF once", async () => {
  const { migrateAutoLearnOff, AUTO_LEARN_KEY, AUTO_LEARN_MIGRATION_KEY } = await load();
  const s = memStorage({ [AUTO_LEARN_KEY]: "true" });
  migrateAutoLearnOff(s);
  assert.equal(s.data[AUTO_LEARN_KEY], "false");
  assert.equal(s.data[AUTO_LEARN_MIGRATION_KEY], "true");
});

test("a manual ON after the migration sticks", async () => {
  const { migrateAutoLearnOff, AUTO_LEARN_KEY } = await load();
  const s = memStorage({ [AUTO_LEARN_KEY]: "true" });
  migrateAutoLearnOff(s);
  s.setItem(AUTO_LEARN_KEY, "true");
  migrateAutoLearnOff(s);
  assert.equal(s.data[AUTO_LEARN_KEY], "true");
});

test("migration on a fresh install only records that it ran", async () => {
  const { migrateAutoLearnOff, AUTO_LEARN_KEY, AUTO_LEARN_MIGRATION_KEY } = await load();
  const s = memStorage();
  migrateAutoLearnOff(s);
  assert.equal(AUTO_LEARN_KEY in s.data, false);
  assert.equal(s.data[AUTO_LEARN_MIGRATION_KEY], "true");
});
