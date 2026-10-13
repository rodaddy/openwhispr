const assert = require("node:assert/strict");
const test = require("node:test");
const load = () => import("../../src/components/onboarding/flow.ts");
const baseRoute = [
  "permissions",
  "languages",
  "use-cases",
  "dictation-hotkey",
  "activation-mode",
  "dictation-demo",
  "assistant-hotkey",
  "assistant-demo",
  "notes",
  "setup-choice",
];

test("onboarding starts with permissions and contains no account step", async () => {
  const { createOnboardingSession, getOnboardingRoute } = await load();
  assert.deepEqual(
    getOnboardingRoute({ authPath: "guest", setupMode: null, agentAllowed: true }),
    baseRoute
  );
  assert.equal(createOnboardingSession().currentStepId, "permissions");
});

test("every route configures activation after the dictation shortcut", async () => {
  const { getOnboardingRoute } = await load();
  for (const setupMode of [null, "byok", "local"]) {
    const route = getOnboardingRoute({ authPath: "guest", setupMode, agentAllowed: true });
    assert.equal(route[route.indexOf("dictation-hotkey") + 1], "activation-mode");
  }
});

test("policy removes assistant steps while retaining local setup", async () => {
  const { getOnboardingRoute } = await load();
  const route = getOnboardingRoute({ authPath: "guest", setupMode: "local", agentAllowed: false });
  assert.equal(
    route.some((step) => step.includes("assistant")),
    false
  );
  assert.deepEqual(route.slice(-2), ["setup-choice", "local-dictation"]);
});

test("setup choice appends BYOK or local provider configuration", async () => {
  const { getOnboardingRoute } = await load();
  assert.deepEqual(
    getOnboardingRoute({ authPath: "guest", setupMode: "byok", agentAllowed: true }).slice(-3),
    ["setup-choice", "byok-dictation", "byok-assistant"]
  );
  assert.deepEqual(
    getOnboardingRoute({ authPath: "guest", setupMode: "local", agentAllowed: true }).slice(-3),
    ["setup-choice", "local-dictation", "local-assistant"]
  );
});

test("persisted account sessions are adopted as local guest sessions", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  const session = { ...createOnboardingSession(), authPath: "account", currentStepId: "notes" };
  assert.deepEqual(parseOnboardingSession(JSON.stringify(session)), {
    ...session,
    authPath: "guest",
  });
});

test("persisted cloud sessions are rejected so setup restarts safely", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  assert.equal(
    parseOnboardingSession(JSON.stringify({ ...createOnboardingSession(), setupMode: "cloud" })),
    null
  );
});

test("versioned sessions reject malformed data and adopt older optional fields", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  assert.equal(parseOnboardingSession(null), null);
  assert.equal(parseOnboardingSession("not json"), null);
  assert.equal(parseOnboardingSession('{"version":1,"currentStepId":"permissions"}'), null);
  const legacy = { ...createOnboardingSession() };
  delete legacy.selfHostedRequested;
  assert.equal(parseOnboardingSession(JSON.stringify(legacy)).selfHostedRequested, false);
});

test("restart clears persisted account-era state and returns to permissions", async () => {
  const { migrateLegacyOnboardingStep, resetOnboardingProgress } = await load();
  const values = new Map([
    ["onboardingSessionV2", "saved"],
    ["onboardingCompleted", "true"],
    ["authenticationSkipped", "true"],
    ["skipAuth", "true"],
  ]);
  resetOnboardingProgress({
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  });
  assert.equal(values.get("onboardingCurrentStep"), "0");
  assert.equal(values.has("onboardingSessionV2"), false);
  assert.equal(values.has("authenticationSkipped"), false);
  assert.equal(migrateLegacyOnboardingStep("0"), "permissions");
  assert.equal(migrateLegacyOnboardingStep("2"), "permissions");
  assert.equal(migrateLegacyOnboardingStep("4"), "dictation-hotkey");
});

test("route helpers recover without skipping required local setup", async () => {
  const { getNextOnboardingStep, getOnboardingRoute, reconcileStepWithRoute } = await load();
  const route = getOnboardingRoute({ authPath: "guest", setupMode: null, agentAllowed: false });
  assert.equal(reconcileStepWithRoute("assistant-hotkey", route), "dictation-demo");
  assert.equal(reconcileStepWithRoute("assistant-demo", route), "notes");
  assert.equal(getNextOnboardingStep("permissions", route), "languages");
  assert.equal(getNextOnboardingStep("setup-choice", route), null);
});

test("progress counts only full-frame steps and tracks provider setup", async () => {
  const { getOnboardingProgress, getOnboardingRoute } = await load();
  const route = getOnboardingRoute({ authPath: "guest", setupMode: null, agentAllowed: true });
  assert.equal(getOnboardingProgress("permissions", route), null);
  assert.deepEqual(getOnboardingProgress("languages", route), { index: 0, total: 9 });
  assert.deepEqual(getOnboardingProgress("setup-choice", route), { index: 8, total: 9 });
  const byok = getOnboardingRoute({ authPath: "guest", setupMode: "byok", agentAllowed: true });
  assert.deepEqual(getOnboardingProgress("byok-assistant", byok), { index: 10, total: 11 });
});

test("retired managed-model sessions never suppress the local download tray", async () => {
  const { createOnboardingSession, isRequiredModelsOnboardingStepActive } = await load();
  assert.equal(isRequiredModelsOnboardingStepActive(null), false);
  assert.equal(
    isRequiredModelsOnboardingStepActive(JSON.stringify(createOnboardingSession())),
    false
  );
});

test("the optional assistant-hotkey step and the demos offer Skip until complete, required steps never do", async () => {
  const { canSkipOnboardingStep } = await load();
  assert.equal(canSkipOnboardingStep("assistant-hotkey", false), true);
  assert.equal(canSkipOnboardingStep("assistant-demo", false), true);
  assert.equal(canSkipOnboardingStep("assistant-hotkey", true), false);
  assert.equal(canSkipOnboardingStep("dictation-hotkey", false), false);
});
