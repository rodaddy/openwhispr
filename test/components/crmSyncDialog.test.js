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
const disabled = (node) =>
  node[Object.keys(node).find((key) => key.startsWith("__reactProps"))].disabled;

async function mountDialog(t, electronAPI, { initialState = null } = {}) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { electronAPI } });
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
  const childText = (value) => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(childText).join(" ");
    return value?.props ? childText(value.props.children) : "";
  };
  const hostText = (node) => childText(reactProps(node)?.children);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-crm-sync-dialog-",
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
        export const DialogDescription = ({ children }) => React.createElement(React.Fragment, null, children);
        export const DialogFooter = ({ children }) => React.createElement(React.Fragment, null, children);
        export const DialogHeader = ({ children }) => React.createElement(React.Fragment, null, children);
        export const DialogTitle = ({ children }) => React.createElement(React.Fragment, null, children);
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
        export const Badge = ({ children }) => React.createElement(React.Fragment, null, children);
      `,
      "lucide-react": `
        export const Contact = () => null;
        export const ExternalLink = () => null;
        export const Loader2 = () => null;
        export const Search = () => null;
      `,
    },
  });
  const { default: CrmSyncDialog } = await vite.ssrLoadModule(
    "/components/notes/CrmSyncDialog.tsx"
  );
  const note = { id: 42, title: "Quarterly review", participants: null };
  const events = [];
  let setBlocked;
  function Harness() {
    const [state, setState] = React.useState(initialState);
    const [blocked, setBlockedState] = React.useState(false);
    setBlocked = setBlockedState;
    return React.createElement(CrmSyncDialog, {
      open: true,
      onOpenChange() {},
      note,
      initialState: state,
      async onBeforeSync() {
        events.push("before");
      },
      onSynced(next) {
        events.push("synced");
        setState(next);
      },
      blocked,
    });
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  await React.act(async () => wait(10));

  const button = (text) =>
    allNodes().find((node) => node.tagName === "BUTTON" && hostText(node).trim() === text);
  const hasText = (text) => allNodes().some((node) => hostText(node).includes(text));
  const click = (node) =>
    React.act(async () => {
      reactProps(node).onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
  const type = (value) =>
    React.act(async () => {
      const input = allNodes().find((node) => node.tagName === "INPUT");
      reactProps(input).onChange({ target: { value } });
    });
  const settle = (milliseconds) => React.act(async () => wait(milliseconds));
  const resolve = (fn) =>
    React.act(async () => {
      fn();
      await Promise.resolve();
    });
  const contactButton = (name) =>
    allNodes().find((node) => node.tagName === "BUTTON" && hostText(node).includes(name));
  return {
    button,
    hasText,
    click,
    type,
    settle,
    resolve,
    contactButton,
    events,
    setBlocked: (value) => React.act(async () => setBlocked(value)),
  };
}

const opportunities = [
  { id: "o1", name: "Website rebuild", status: "open", pipelineId: "p", pipelineStageId: "s" },
  { id: "o2", name: "Retainer", status: "won", pipelineId: "p", pipelineStageId: "s" },
];

test("GHL dialog debounces contact search, ignores stale results, and syncs contact + opportunity", async (t) => {
  const searches = [];
  const pendingSearch = new Map();
  const listed = [];
  const pendingList = new Map();
  const syncs = [];
  const ui = await mountDialog(t, {
    crmSearchContacts(query) {
      searches.push(query);
      return new Promise((resolve) => pendingSearch.set(query, resolve));
    },
    crmListOpportunities(contactId) {
      listed.push(contactId);
      return new Promise((resolve) => pendingList.set(contactId, resolve));
    },
    async crmSyncNote(noteId, target) {
      syncs.push({ noteId, target });
      return {
        success: true,
        state: {
          noteId: "ghl-note-1",
          ...target,
          syncedAt: "2026-10-07T12:00:00.000Z",
          url: "https://app.gohighlevel.com/v2/location/loc/contacts/detail/c1",
        },
      };
    },
    openExternal() {},
  });

  assert.deepEqual(searches, [], "a blank query never searches");
  assert.equal(ui.hasText("New contact"), false);
  assert.equal(disabled(ui.button("Sync to GoHighLevel")), true);

  await ui.type("A");
  await ui.settle(100);
  assert.deepEqual(searches, [], "search waits for the debounce");
  await ui.settle(250);
  assert.deepEqual(searches, ["A"]);
  await ui.type("Acme");
  await ui.settle(325);
  assert.deepEqual(searches, ["A", "Acme"]);

  await ui.resolve(() =>
    pendingSearch.get("Acme")({
      success: true,
      contacts: [
        { id: "c1", name: "Ada Lovelace", email: "ada@example.com" },
        { id: "c2", name: "Grace Hopper", phone: "+1 555 0100" },
      ],
    })
  );
  await ui.resolve(() =>
    pendingSearch.get("A")({ success: true, contacts: [{ id: "old", name: "Stale Person" }] })
  );
  assert.equal(ui.hasText("Stale Person"), false);
  assert.equal(ui.hasText("ada@example.com"), true);
  assert.equal(ui.hasText("+1 555 0100"), true);

  await ui.click(ui.contactButton("Grace Hopper"));
  assert.deepEqual(listed, ["c2"]);
  await ui.resolve(() => pendingList.get("c2")({ success: true, opportunities: [] }));
  assert.equal(ui.hasText("This contact has no opportunities in GoHighLevel."), true);

  await ui.click(ui.contactButton("Ada Lovelace"));
  assert.deepEqual(listed, ["c2", "c1"]);
  await ui.resolve(() => pendingList.get("c1")({ success: true, opportunities }));
  assert.equal(ui.hasText("Website rebuild"), true);
  assert.equal(ui.hasText("Won"), true, "status label is shown");
  const syncButton = () => ui.button("Sync to GoHighLevel");
  assert.equal(disabled(syncButton()), true, "no opportunity chosen yet");

  await ui.click(ui.contactButton("Retainer"));
  assert.equal(disabled(syncButton()), false);
  await ui.setBlocked(true);
  assert.equal(disabled(syncButton()), true, "blocked disables sync");
  await ui.setBlocked(false);

  await ui.click(syncButton());
  assert.deepEqual(syncs, [{ noteId: 42, target: { contactId: "c1", opportunityId: "o2" } }]);
  assert.deepEqual(ui.events, ["before", "synced"]);
  assert.ok(ui.button("Update GoHighLevel note"));
});

test("GHL dialog preselects the synced opportunity and shows a TARGET_CHANGED failure", async (t) => {
  const listed = [];
  const opened = [];
  const syncs = [];
  const initialState = {
    noteId: "ghl-note-1",
    contactId: "c1",
    opportunityId: "o2",
    syncedAt: "2026-10-07T12:00:00.000Z",
    url: "https://app.gohighlevel.com/v2/location/loc/contacts/detail/c1",
  };
  const ui = await mountDialog(
    t,
    {
      async crmSearchContacts() {
        return { success: true, contacts: [{ id: "c9", name: "Other Person" }] };
      },
      async crmListOpportunities(contactId) {
        listed.push(contactId);
        return {
          success: true,
          opportunities:
            contactId === "c1"
              ? opportunities
              : [
                  {
                    id: "o9",
                    name: "Other deal",
                    status: "open",
                    pipelineId: "p",
                    pipelineStageId: "s",
                  },
                ],
        };
      },
      async crmSyncNote(noteId, target) {
        syncs.push({ noteId, target });
        return {
          success: false,
          code: "TARGET_CHANGED",
          error: "This note is already synced to a different GoHighLevel contact.",
        };
      },
      openExternal(url) {
        opened.push(url);
      },
    },
    { initialState }
  );

  assert.deepEqual(listed, ["c1"]);
  assert.equal(ui.hasText("Synced"), true);
  await ui.click(ui.button("Open in GoHighLevel"));
  assert.deepEqual(opened, [initialState.url]);

  const update = ui.button("Update GoHighLevel note");
  assert.equal(disabled(update), false, "preselected opportunity allows Update without search");
  await ui.click(update);
  assert.deepEqual(syncs, [{ noteId: 42, target: { contactId: "c1", opportunityId: "o2" } }]);

  await ui.type("Other");
  await ui.settle(325);
  await ui.click(ui.contactButton("Other Person"));
  await ui.settle(10);
  assert.deepEqual(listed, ["c1", "c9"]);
  assert.equal(disabled(ui.button("Update GoHighLevel note")), true, "new contact needs a pick");
  await ui.click(ui.contactButton("Other deal"));
  await ui.click(ui.button("Update GoHighLevel note"));
  assert.deepEqual(syncs[1], { noteId: 42, target: { contactId: "c9", opportunityId: "o9" } });
  assert.equal(ui.hasText("This note is already synced to a different GoHighLevel contact."), true);
});

test("GHL dialog drops the previous results when the query changes and clears them on a failed search", async (t) => {
  const pendingSearch = new Map();
  const listed = [];
  const ui = await mountDialog(t, {
    crmSearchContacts(query) {
      return new Promise((resolve) => pendingSearch.set(query, resolve));
    },
    async crmListOpportunities(contactId) {
      listed.push(contactId);
      return { success: true, opportunities };
    },
    async crmSyncNote() {
      throw new Error("sync must not run");
    },
    openExternal() {},
  });

  await ui.type("Ada");
  await ui.settle(325);
  await ui.resolve(() =>
    pendingSearch.get("Ada")({
      success: true,
      contacts: [{ id: "c1", name: "Ada Lovelace", email: "ada@example.com" }],
    })
  );
  assert.ok(ui.contactButton("Ada Lovelace"), "search 1 results are pickable");

  await ui.type("Grace");
  assert.equal(
    Boolean(ui.contactButton("Ada Lovelace")),
    false,
    "search 1 results are not pickable while the new query waits for its search"
  );
  await ui.settle(325);
  assert.equal(Boolean(ui.contactButton("Ada Lovelace")), false, "nor while search 2 is in flight");

  await ui.resolve(() =>
    pendingSearch.get("Grace")({ success: false, error: "GoHighLevel search failed." })
  );
  assert.equal(ui.hasText("GoHighLevel search failed."), true);
  assert.equal(Boolean(ui.contactButton("Ada Lovelace")), false, "a failed search leaves no list");
  assert.deepEqual(listed, [], "no contact from search 1 was picked");
  assert.equal(disabled(ui.button("Sync to GoHighLevel")), true);
});
