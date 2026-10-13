const test = require("node:test");
const assert = require("node:assert/strict");

const { isAppUrl, decidePermission } = require("../../src/helpers/permissionPolicy");
const { installPermissionHandlers } = require("../../src/helpers/permissionHandlers");

const DEV = "http://localhost:5183";

test("isAppUrl: packaged file:// pages are the app", () => {
  assert.equal(isAppUrl("file:///Applications/x/index.html"), true);
  assert.equal(isAppUrl("file://"), true);
});

test("isAppUrl: devtools pages are the app", () => {
  assert.equal(isAppUrl("devtools://devtools/bundled/x"), true);
});

test("isAppUrl: the dev server origin counts only when a dev URL is supplied", () => {
  assert.equal(isAppUrl("http://localhost:5183/?a=1", { devServerUrl: DEV }), true);
  assert.equal(isAppUrl("http://localhost:5183/?a=1"), false);
});

test("isAppUrl: another port is another origin", () => {
  assert.equal(isAppUrl("http://localhost:9999/", { devServerUrl: DEV }), false);
});

test("isAppUrl: foreign, empty and unparseable URLs are not the app", () => {
  assert.equal(isAppUrl("https://example.com"), false);
  assert.equal(isAppUrl("https://example.com", { devServerUrl: DEV }), false);
  assert.equal(isAppUrl(""), false);
  assert.equal(isAppUrl(null), false);
  assert.equal(isAppUrl(undefined), false);
  assert.equal(isAppUrl("not a url"), false);
  assert.equal(isAppUrl("not a url", { devServerUrl: DEV }), false);
});

test("decidePermission follows isAppUrl whatever the permission", () => {
  assert.equal(decidePermission({ url: "file:///x/index.html", permission: "media" }), true);
  assert.equal(decidePermission({ url: "https://example.com", permission: "media" }), false);
  assert.equal(
    decidePermission({ url: "http://localhost:5183/", permission: "media", devServerUrl: DEV }),
    true
  );
});

function install(options) {
  const handlers = {};
  const fakeSession = {
    setPermissionRequestHandler: (handler) => {
      handlers.request = handler;
    },
    setPermissionCheckHandler: (handler) => {
      handlers.check = handler;
    },
  };
  const result = installPermissionHandlers(fakeSession, options);
  assert.equal(result, undefined);
  const request = (webContents, permission, details) => {
    let answer;
    handlers.request(webContents, permission, (granted) => (answer = granted), details);
    return answer;
  };
  return { request, check: handlers.check };
}

test("request handler grants the app's pages and denies foreign origins", () => {
  const { request } = install();
  assert.equal(request(null, "media", { requestingUrl: "file:///x/index.html" }), true);
  assert.equal(request(null, "media", { requestingUrl: "https://example.com/page" }), false);
});

test("request handler falls back to webContents.getURL() when details has no URL", () => {
  const { request } = install();
  assert.equal(request({ getURL: () => "file:///x/index.html" }, "media", {}), true);
  assert.equal(request({ getURL: () => "https://example.com/" }, "media", undefined), false);
});

test("check handler grants file:// and denies foreign or unknown origins", () => {
  const { check } = install();
  assert.equal(check(null, "media", "file://", {}), true);
  assert.equal(check(null, "media", "https://example.com", {}), false);
  assert.equal(check(null, "media", "", undefined), false);
});

test("handlers honor the dev server origin only when configured", () => {
  const dev = install({ devServerUrl: DEV });
  assert.equal(dev.check(null, "media", "http://localhost:5183", {}), true);
  assert.equal(dev.request(null, "media", { requestingUrl: "http://localhost:5183/?a=1" }), true);
  const packaged = install();
  assert.equal(packaged.check(null, "media", "http://localhost:5183", {}), false);
});

test("a throwing webContents.getURL denies instead of throwing", () => {
  const { request, check } = install();
  const broken = {
    getURL: () => {
      throw new Error("webContents destroyed");
    },
  };
  assert.equal(request(broken, "media", {}), false);
  assert.equal(check(broken, "media", "", {}), false);
});

test("a throwing log does not change the decision", () => {
  const { request } = install({
    log: () => {
      throw new Error("logger down");
    },
  });
  assert.equal(request(null, "media", { requestingUrl: "https://example.com/" }), false);
});

test("a denial is logged once per origin and permission, without the query string", () => {
  const lines = [];
  const { request, check } = install({ log: (line) => lines.push(line) });
  const details = { requestingUrl: "https://example.com/cb?token=secret#frag" };
  request(null, "media", details);
  request(null, "media", details);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /https:\/\/example\.com/);
  assert.match(lines[0], /media/);
  assert.doesNotMatch(lines[0], /token|secret|\?|cb|frag/);

  check(null, "media", "https://example.com", {});
  assert.equal(lines.length, 1);
  request(null, "geolocation", details);
  assert.equal(lines.length, 2);
  request(null, "media", { requestingUrl: "file:///x/index.html" });
  assert.equal(lines.length, 2);
});

test("a sub-frame with no requester of its own does not borrow the app page's URL", () => {
  const { request, check } = install();
  const appPage = { getURL: () => "file:///x/index.html" };

  assert.equal(request(appPage, "media", { isMainFrame: false }), false);
  assert.equal(check(appPage, "media", "", { isMainFrame: false }), false);
  // The main frame still falls back to the page URL.
  assert.equal(request(appPage, "media", { isMainFrame: true }), true);
  assert.equal(check(appPage, "media", "", { isMainFrame: true }), true);
  // A sub-frame that names an app URL itself is still the app.
  assert.equal(check(appPage, "media", "file:///", { isMainFrame: false }), true);
});

test("a denial the log could not record is reported again", () => {
  const lines = [];
  let ready = false;
  const { request } = install({
    log: (line) => {
      if (!ready) return false;
      lines.push(line);
    },
  });
  const details = { requestingUrl: "https://example.com/" };

  request(null, "media", details);
  assert.equal(lines.length, 0);
  ready = true;
  request(null, "media", details);
  request(null, "media", details);
  assert.equal(lines.length, 1);
});
