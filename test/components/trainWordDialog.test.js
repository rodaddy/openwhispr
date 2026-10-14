const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Train a word dialog: useTrainerTake and useSettings are mocked, so each
// take resolves to the next queued result and every settings write is recorded.
async function setup(t, results) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__trainer;
  });
  const writes = { snippets: [], dictionary: [] };
  globalThis.__trainer = {
    results: [...results],
    // One take at a time, like the real hook: a take left running blocks the next.
    running: false,
    cancels: 0,
    stopGate: null,
    // The running take's single result (useTrainerTake's waitTake).
    pending: null,
    // The take ends by itself, as auto-stop does.
    autoEnd() {
      if (!this.running) return;
      this.running = false;
      this.pending.resolve(this.results.shift());
    },
    settings: {
      snippets: [{ trigger: "my cal", replacement: "cal.com/me" }],
      setSnippets: (value) => writes.snippets.push(value),
      updateCustomDictionary: (value) => writes.dictionary.push(value),
    },
  };
  installBrowserGlobals(t);
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
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      removeAttribute() {},
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
    // React writes a lone string child through textContent.
    Object.defineProperty(node, "textContent", {
      set(value) {
        this.childNodes = value ? [makeNode(String(value), 3)] : [];
      },
    });
    return node;
  };
  Object.assign(container, {
    childNodes: [],
    appendChild: makeNode("div").appendChild,
    insertBefore: makeNode("div").insertBefore,
    removeChild: makeNode("div").removeChild,
  });
  globalThis.document.createElement = (tagName) => makeNode(tagName);
  globalThis.document.createElementNS = (_namespace, tagName) => makeNode(tagName);
  globalThis.document.createTextNode = (value) => makeNode(String(value), 3);

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-train-word-dialog-",
    mockModules: {
      "react-i18next": `
        export const useTranslation = () => ({
          t: (key, options) => (options ? key + " " + JSON.stringify(options) : key),
        });
      `,
      "/ui/dialog": `
        import React from "react";
        const Pass = ({ children }) => React.createElement(React.Fragment, null, children);
        export const Dialog = ({ open, children }) => (open ? React.createElement(React.Fragment, null, children) : null);
        export const DialogContent = Pass;
        export const DialogDescription = Pass;
        export const DialogFooter = Pass;
        export const DialogHeader = Pass;
        export const DialogTitle = Pass;
      `,
      "/ui/button": `
        import React from "react";
        export const Button = ({ children, variant, size, ...props }) => React.createElement("button", props, children);
      `,
      "/ui/input": `
        import React from "react";
        export const Input = (props) => React.createElement("input", props);
      `,
      "lucide-react": `export const X = () => null;`,
      "/hooks/useSettings": `export const useSettings = () => globalThis.__trainer.settings;`,
      "/hooks/useTrainerTake": `
        export const useTrainerTake = () => {
          const s = globalThis.__trainer;
          return {
            startTake: async () => {
              if (s.running) return { error: "a take is already running" };
              s.running = true;
              let resolve;
              const promise = new Promise((done) => (resolve = done));
              s.pending = { promise, resolve };
              return { ok: true };
            },
            waitTake: () => s.pending.promise,
            stopTake: async () => {
              if (s.stopGate) await s.stopGate;
              const result = s.running ? s.results.shift() : { discarded: true };
              s.running = false;
              s.pending?.resolve(result);
              return result;
            },
            cancelTake: () => {
              if (!s.running) return;
              s.running = false;
              s.cancels += 1;
              s.pending.resolve({ discarded: true });
            },
          };
        };
      `,
    },
  });
  const { default: TrainWordDialog } = await vite.ssrLoadModule("/components/TrainWordDialog.tsx");

  const all = () => {
    const rows = [];
    const visit = (node) => {
      rows.push(node);
      node.childNodes?.forEach(visit);
    };
    container.childNodes.forEach(visit);
    return rows;
  };
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith("__reactProps"))];
  const text = (node) =>
    node.nodeType === 3 ? node.nodeValue : (node.childNodes || []).map(text).join("");
  const button = (label, nth = 0) =>
    all().filter(
      (node) =>
        node.tagName === "BUTTON" &&
        (text(node).trim() === label || props(node)?.["aria-label"]?.startsWith(label))
    )[nth];
  const click = (label, nth) =>
    React.act(async () => {
      await props(button(label, nth)).onClick();
    });
  const page = () => text(container);
  // Starts a click without waiting for its handler; { done } settles when it does.
  const press = async (label, nth) => {
    const pending = props(button(label, nth)).onClick();
    await React.act(async () => {});
    return { done: pending };
  };
  const disabled = (label) => !!props(button(label))?.disabled;
  let closed = 0;

  root = createRoot(container);
  await React.act(async () => {
    root.render(
      React.createElement(TrainWordDialog, { open: true, onOpenChange: () => (closed += 1) })
    );
  });
  const input = all().find((node) => node.tagName === "INPUT");
  await React.act(async () => props(input).onChange({ target: { value: "Kubernetes" } }));

  // Record a take, end it with Stop (or `end`), and wait for record() to settle.
  const take = async (label = "dictionary.trainer.record", end) => {
    const recording = await press(label);
    if (end) end();
    else await click("dictionary.trainer.stop");
    await React.act(async () => {
      await recording.done;
    });
  };
  // Record and stop every take in order.
  const recordAll = async (count = 3) => {
    for (let i = 0; i < count; i += 1) await take();
  };
  return { writes, click, press, take, disabled, page, recordAll, closed: () => closed };
}

const THREE = [
  { rawText: "cooper netties" },
  { rawText: "Kubernetes." },
  { rawText: "cube and eighties" },
];

test("3 takes, 2 differ: Save writes 2 corrections and 1 dictionary add", async (t) => {
  const ui = await setup(t, THREE);
  await ui.recordAll();
  assert.match(ui.page(), /cooper netties → Kubernetes/);
  assert.match(ui.page(), /dictionary\.trainer\.alreadyRight/);
  await ui.click("common.save");
  assert.deepEqual(ui.writes.snippets, [
    [
      { trigger: "my cal", replacement: "cal.com/me" },
      { trigger: "cooper netties", replacement: "Kubernetes" },
      { trigger: "cube and eighties", replacement: "Kubernetes" },
    ],
  ]);
  assert.deepEqual(ui.writes.dictionary, [{ add: ["Kubernetes"] }]);
  assert.match(ui.page(), /dictionary\.trainer\.saved/);
});

test("removing a correction before Save drops it", async (t) => {
  const ui = await setup(t, THREE);
  await ui.recordAll();
  await ui.click("dictionary.snippets.remove", 0);
  await ui.click("common.save");
  assert.deepEqual(ui.writes.snippets[0].slice(1), [
    { trigger: "cube and eighties", replacement: "Kubernetes" },
  ]);
  assert.deepEqual(ui.writes.dictionary, [{ add: ["Kubernetes"] }]);
});

test("Cancel writes nothing", async (t) => {
  const ui = await setup(t, THREE);
  await ui.recordAll();
  await ui.click("common.cancel");
  assert.deepEqual(ui.writes, { snippets: [], dictionary: [] });
  assert.equal(ui.closed(), 1);
});

test("an errored take shows why and can be redone", async (t) => {
  const ui = await setup(t, [{ error: "No speech heard" }, { rawText: "cooper netties" }]);
  await ui.take();
  assert.match(ui.page(), /dictionary\.trainer\.noSpeech/);
  await ui.take("dictionary.trainer.redo");
  assert.match(ui.page(), /cooper netties → Kubernetes/);
  assert.doesNotMatch(ui.page(), /dictionary\.trainer\.noSpeech/);
});

test("Cancel mid-take stops the take and the next Record works", async (t) => {
  const ui = await setup(t, [{ rawText: "cooper netties" }]);
  const first = await ui.press("dictionary.trainer.record");
  await ui.click("common.cancel");
  await React.act(async () => {
    await first.done;
  });
  assert.equal(globalThis.__trainer.cancels, 1);
  assert.equal(globalThis.__trainer.running, false);
  await ui.press("dictionary.trainer.record");
  assert.match(ui.page(), /dictionary\.trainer\.listening/);
  assert.doesNotMatch(ui.page(), /already running/);
});

test("a take that finishes after Cancel does not land in the next session", async (t) => {
  const ui = await setup(t, [{ rawText: "cooper netties" }]);
  let release;
  globalThis.__trainer.stopGate = new Promise((resolve) => (release = resolve));
  const recording = await ui.press("dictionary.trainer.record");
  const stopping = await ui.press("dictionary.trainer.stop");
  await ui.click("common.cancel");
  await React.act(async () => {
    release();
    await stopping.done;
    await recording.done;
  });
  assert.doesNotMatch(ui.page(), /cooper netties/);
  assert.doesNotMatch(ui.page(), /dictionary\.trainer\.discarded/);
  assert.equal(ui.disabled("common.save"), true);
});

test("a take that ends by itself shows as heard and Record is ready for the next", async (t) => {
  const ui = await setup(t, [{ rawText: "cooper netties" }]);
  await ui.take("dictionary.trainer.record", () => globalThis.__trainer.autoEnd());
  assert.match(ui.page(), /cooper netties → Kubernetes/);
  assert.doesNotMatch(ui.page(), /dictionary\.trainer\.listening/);
  assert.equal(globalThis.__trainer.running, false);
  assert.equal(ui.disabled("dictionary.trainer.record"), false);
});

test("a take that ends by itself with no speech shows the no-speech message", async (t) => {
  const ui = await setup(t, [{ error: "No speech heard" }]);
  await ui.take("dictionary.trainer.record", () => globalThis.__trainer.autoEnd());
  assert.match(ui.page(), /dictionary\.trainer\.noSpeech/);
});
