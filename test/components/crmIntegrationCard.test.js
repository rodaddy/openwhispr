const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

function installNodeDom(container) {
  const makeNode = (tagName, nodeType = 1) => {
    const node = {
      nodeType,
      nodeName: nodeType === 3 ? "#text" : tagName.toUpperCase(),
      tagName: nodeType === 3 ? undefined : tagName.toUpperCase(),
      namespaceURI: "http://www.w3.org/1999/xhtml",
      ownerDocument: globalThis.document,
      parentNode: null,
      childNodes: [],
      style: {},
      attributes: {},
      addEventListener() {},
      removeEventListener() {},
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      removeAttribute(name) {
        delete this.attributes[name];
      },
      focus() {},
    };
    if (nodeType === 3) node.nodeValue = tagName;
    attachChildren(node);
    Object.defineProperty(node, "textContent", {
      get() {
        return this.nodeType === 3
          ? this.nodeValue
          : this.childNodes.map((child) => child.textContent).join("");
      },
      set(value) {
        this.childNodes = value ? [makeNode(String(value), 3)] : [];
      },
    });
    return node;
  };
  function attachChildren(node) {
    node.childNodes = [];
    node.appendChild = function (child) {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    };
    node.insertBefore = function (child, before) {
      child.parentNode = this;
      const index = this.childNodes.indexOf(before);
      this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
      return child;
    };
    node.removeChild = function (child) {
      this.childNodes = this.childNodes.filter((candidate) => candidate !== child);
      child.parentNode = null;
      return child;
    };
  }
  attachChildren(container);
  globalThis.document.createElement = (tagName) => makeNode(tagName);
  globalThis.document.createElementNS = (_namespace, tagName) => makeNode(tagName);
  globalThis.document.createTextNode = (value) => makeNode(String(value), 3);
}

test("GoHighLevel card saves, removes and tests the private integration token", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const saves = [];
  let tests = 0;
  let testResult = { success: true, locationName: "rTech Consulting" };
  let settings = { configured: false, hasToken: false, locationId: "loc-rtech-1" };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        async crmGetSettings() {
          return { success: true, settings };
        },
        async crmSaveSettings(input) {
          saves.push(input);
          const hasToken = typeof input.token === "string" && input.token.length > 0;
          settings = { ...settings, hasToken, configured: hasToken };
          return { success: true, settings };
        },
        async crmTestConnection() {
          tests += 1;
          return testResult;
        },
      },
    },
  });
  const container = installHookDom(t);
  installNodeDom(container);

  const allNodes = () => {
    const rows = [];
    const visit = (node) => {
      rows.push(node);
      node.childNodes?.forEach(visit);
    };
    container.childNodes.forEach(visit);
    return rows;
  };
  const reactProps = (node) =>
    node[Object.keys(node).find((key) => key.startsWith("__reactProps"))];
  const text = () => container.childNodes.map((node) => node.textContent).join(" ");
  const button = (label) =>
    allNodes().find((node) => node.tagName === "BUTTON" && node.textContent.trim() === label);
  const input = () => allNodes().find((node) => node.tagName === "INPUT");
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-crm-integration-card-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export const useTranslation = () => ({
          t: (key, options = {}) =>
            Object.entries(options).reduce(
              (text, [name, value]) => text.split("{{" + name + "}}").join(String(value)),
              options.defaultValue || key
            ),
        });
      `,
      "/ui/button": `
        import React from "react";
        export const Button = ({ children, ...props }) => React.createElement("button", props, children);
      `,
      "/ui/input": `
        import React from "react";
        export const Input = (props) => React.createElement("input", props);
      `,
      "/ui/badge": `
        import React from "react";
        export const Badge = ({ children }) => React.createElement("span", null, children);
      `,
      "lucide-react": `
        export const CheckCircle2 = () => null;
        export const KeyRound = () => null;
        export const Loader2 = () => null;
        export const RefreshCw = () => null;
        export const Trash2 = () => null;
      `,
    },
  });
  const { default: CrmIntegrationCard } = await vite.ssrLoadModule(
    "/components/CrmIntegrationCard.tsx"
  );

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(CrmIntegrationCard));
    await settle();
  });

  assert.match(text(), /GoHighLevel/);
  assert.match(text(), /loc-rtech-1/);
  assert.match(text(), /Not configured/);
  assert.equal(reactProps(input()).type, "password");
  assert.equal(reactProps(button("Save")).disabled, true);
  assert.equal(reactProps(button("Test connection")).disabled, true);
  assert.equal(button("Remove token"), undefined);

  await React.act(async () => {
    reactProps(input()).onChange({ target: { value: "  pit-secret-123  " } });
  });
  assert.equal(reactProps(button("Save")).disabled, false);
  await React.act(async () => {
    reactProps(button("Save")).onClick();
    await settle();
  });
  assert.deepEqual(saves, [{ token: "pit-secret-123" }]);
  assert.equal(reactProps(input()).value, "");
  assert.equal(reactProps(input()).placeholder, "Leave blank to keep the saved token");
  assert.match(text(), /Configured/);
  assert.doesNotMatch(text(), /Not configured/);
  assert.doesNotMatch(text(), /pit-secret-123/);

  await React.act(async () => {
    reactProps(button("Test connection")).onClick();
    await settle();
  });
  assert.equal(tests, 1);
  assert.match(text(), /Connected to rTech Consulting/);

  testResult = {
    success: false,
    error: "GoHighLevel rejected the token (HTTP 401)",
    code: "AUTH_FAILED",
    status: 401,
  };
  await React.act(async () => {
    reactProps(button("Test connection")).onClick();
    await settle();
  });
  assert.match(text(), /GoHighLevel rejected the token \(HTTP 401\)/);
  assert.doesNotMatch(text(), /Save changes before testing the connection\./);

  // Test connection checks the SAVED token, so a typed replacement must be saved first.
  await React.act(async () => {
    reactProps(input()).onChange({ target: { value: "pit-replacement-456" } });
  });
  assert.equal(reactProps(button("Test connection")).disabled, true);
  assert.match(text(), /Save changes before testing the connection\./);
  await React.act(async () => {
    reactProps(input()).onChange({ target: { value: "   " } });
  });
  assert.equal(reactProps(button("Test connection")).disabled, false);
  assert.doesNotMatch(text(), /Save changes before testing the connection\./);

  await React.act(async () => {
    reactProps(button("Remove token")).onClick();
    await settle();
  });
  assert.deepEqual(saves, [{ token: "pit-secret-123" }, { token: null }]);
  assert.match(text(), /Not configured/);
  assert.equal(button("Remove token"), undefined);
});
