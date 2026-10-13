const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { classifySyncError } = require("../../src/helpers/calendarSyncHealth.js");

// The OAuth modules require electron's net; stub it so they load under node.
function loadWithoutElectron(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  const originalLoad = Module._load;
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") return { net: {} };
    return originalLoad(request, parent, isMain);
  };
  try {
    return require(resolved);
  } finally {
    Module._load = originalLoad;
  }
}

const expiredTokens = { refresh_token: "r", expires_at: 0, scope: "s" };

async function refreshError(oauth, email) {
  try {
    await oauth.getValidAccessToken(email);
  } catch (err) {
    return err;
  }
  assert.fail("expected the token refresh to throw");
}

test("Google revoked refresh token classifies as auth", async () => {
  const GoogleCalendarOAuth = loadWithoutElectron("../../src/helpers/googleCalendarOAuth.js");
  const oauth = new GoogleCalendarOAuth({
    getGoogleTokensByEmail: () => ({ ...expiredTokens, google_email: "a@x.com" }),
  });
  oauth.refreshAccessToken = async () => ({
    error: "invalid_grant",
    error_description: "Token has been expired or revoked.",
  });
  const err = await refreshError(oauth, "a@x.com");
  assert.equal(err.message, "Token refresh failed: Token has been expired or revoked.");
  assert.equal(classifySyncError(err), "auth");
});

test("Microsoft inactivity-expired refresh token classifies as auth", async () => {
  const MicrosoftCalendarOAuth = loadWithoutElectron("../../src/helpers/microsoftCalendarOAuth.js");
  const oauth = new MicrosoftCalendarOAuth({
    getMicrosoftTokensByEmail: () => ({ ...expiredTokens, microsoft_email: "a@x.com" }),
  });
  oauth.refreshAccessToken = async () => ({
    error: "invalid_grant",
    error_description:
      "AADSTS700082: The refresh token has expired due to inactivity. The token was issued on 2026-06-01.",
  });
  const err = await refreshError(oauth, "a@x.com");
  assert.equal(classifySyncError(err), "auth");
});

test("a non-auth OAuth error code stays other", () => {
  const err = new Error("Token refresh failed: Service unavailable");
  err.code = "temporarily_unavailable";
  assert.equal(classifySyncError(err), "other");
});
