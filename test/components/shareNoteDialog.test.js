const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("share dialog disables the toggle and explains when sharing is not configured", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        async shareStatus() {
          return { configured: false, baseUrl: "" };
        },
      },
    },
  });
  const container = installHookDom(t);
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
      appendChild(child) {
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
      },
      insertBefore(child, before) {
        child.parentNode = this;
        const index = this.childNodes.indexOf(before);
        this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
        return child;
      },
      removeChild(child) {
        this.childNodes = this.childNodes.filter((candidate) => candidate !== child);
        child.parentNode = null;
        return child;
      },
      focus() {},
    };
    if (nodeType === 3) node.nodeValue = tagName;
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
  container.childNodes = [];
  container.appendChild = function (child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  };
  container.insertBefore = function (child, before) {
    child.parentNode = this;
    const index = this.childNodes.indexOf(before);
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
    return child;
  };
  container.removeChild = function (child) {
    this.childNodes = this.childNodes.filter((candidate) => candidate !== child);
    return child;
  };
  globalThis.document.createElement = (tagName) => makeNode(tagName);
  globalThis.document.createElementNS = (_namespace, tagName) => makeNode(tagName);
  globalThis.document.createTextNode = (value) => makeNode(String(value), 3);
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

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-share-note-dialog-",
    mockModules: {
      "react-i18next": `
        export const useTranslation = () => ({
          t: (key, options = {}) => options.defaultValue || key,
        });
      `,
      "/ui/dialog": `
        import React from "react";
        export const Dialog = ({ children }) => React.createElement(React.Fragment, null, children);
        export const DialogContent = ({ children }) => React.createElement(React.Fragment, null, children);
        export const DialogDescription = ({ children }) => React.createElement("p", null, children);
        export const DialogTitle = ({ children }) => React.createElement("h2", null, children);
      `,
      "/ui/button": `
        import React from "react";
        export const Button = ({ children, ...props }) => React.createElement("button", props, children);
      `,
      "/ui/useToast": `
        export const useToast = () => ({ toast() {} });
      `,
      "/stores/noteStore": `
        export async function persistNoteShareState() {}
      `,
      "lucide-react": `
        export const Check = () => null;
        export const Copy = () => null;
        export const Link2 = () => null;
        export const Loader2 = () => null;
        export const RefreshCw = () => null;
        export const Upload = () => null;
        export const X = () => null;
      `,
    },
  });
  const { default: ShareNoteDialog } = await vite.ssrLoadModule(
    "/components/notes/ShareNoteDialog.tsx"
  );

  root = createRoot(container);
  await React.act(async () => {
    root.render(
      React.createElement(ShareNoteDialog, {
        open: true,
        onOpenChange() {},
        note: { id: 7, title: "Notes", content: "body", is_shared: 0, share_token: null },
      })
    );
  });
  await React.act(async () => {
    await wait(10);
  });

  const toggle = allNodes().find((node) => node.tagName === "BUTTON");
  assert.equal(reactProps(toggle).disabled, true);
  assert.equal(
    allNodes().some((node) => node.textContent?.includes("Sharing isn't set up in this build.")),
    true
  );
});
