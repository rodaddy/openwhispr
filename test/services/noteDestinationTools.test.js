const test = require("node:test");
const assert = require("node:assert/strict");

// RED contract for issue #27.
//
// The current production modules export static ToolDefinition objects. The
// implementation for this issue should refactor those exports into factories
// with the same names:
//
//   createNoteTool({ requestNoteDestination })
//   updateNoteTool({ requestNoteDestination })
//
// The requester is the app-owned user-choice boundary. It may return an
// existing folder or a folder created only after the user confirms in the UI;
// the tools own note save/move only after that result. There is intentionally
// no model-provided `confirmed` argument in these tests.

let toolModules;
async function loadToolModules() {
  if (!toolModules) {
    toolModules = Promise.all([
      import("../../src/services/tools/createNoteTool.ts"),
      import("../../src/services/tools/updateNoteTool.ts"),
    ]);
  }
  return toolModules;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeSpace(id, name, kind = "private") {
  return { id, name, kind };
}

function makeFolder(id, name, space_id, is_default = 0) {
  return { id, name, space_id, is_default };
}

function installElectronApi(t, { spaces, folders, notes = new Map(), getFolders } = {}) {
  const previousWindow = global.window;
  const calls = {
    folderReads: [],
    createFolder: [],
    saveNote: [],
    getNote: [],
    updateNote: [],
  };

  const folderReader =
    getFolders ||
    (async (spaceId) => {
      calls.folderReads.push(spaceId);
      return folders.filter((folder) => spaceId == null || folder.space_id === spaceId);
    });

  global.window = {
    electronAPI: {
      getSpaces: async () => spaces,
      getFolders: async (spaceId) => {
        const result = await folderReader(spaceId);
        if (!getFolders) return result;
        calls.folderReads.push(spaceId);
        return result;
      },
      createFolder: async (...args) => {
        calls.createFolder.push(args);
        return {
          success: true,
          folder: makeFolder(900, args[0], args[1] ?? null),
        };
      },
      saveNote: async (...args) => {
        calls.saveNote.push(args);
        return {
          success: true,
          note: {
            id: 100,
            title: args[0],
            content: args[1],
            note_type: args[2],
            folder_id: args[5] ?? null,
            space_id: args[6] ?? null,
          },
        };
      },
      getNote: async (id) => {
        calls.getNote.push(id);
        return notes.get(id) || null;
      },
      updateNote: async (...args) => {
        calls.updateNote.push(args);
        return { success: true, note: { id: args[0], ...args[1] } };
      },
    },
  };

  t.after(() => {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  });

  return calls;
}

async function makeCreateTool(options = {}) {
  const [{ createNoteTool }] = await loadToolModules();
  assert.equal(
    typeof createNoteTool,
    "function",
    "#27 contract: createNoteTool must become a factory accepting the requester"
  );
  return createNoteTool(options);
}

async function makeUpdateTool(options = {}) {
  const [, { updateNoteTool }] = await loadToolModules();
  assert.equal(
    typeof updateNoteTool,
    "function",
    "#27 contract: updateNoteTool must become a factory accepting the requester"
  );
  return updateNoteTool(options);
}

const privateSpace = makeSpace(1, "Personal");
const teamSpace = makeSpace(2, "Team", "team");

test("create_note uses an explicit existing folder only within the requested space", async (t) => {
  const work = makeFolder(10, "Work", privateSpace.id);
  const sameNameInTeam = makeFolder(20, "Work", teamSpace.id);
  const calls = installElectronApi(t, {
    spaces: [privateSpace, teamSpace],
    folders: [work, sameNameInTeam],
  });
  let requesterCalls = 0;
  const tool = await makeCreateTool({
    requestNoteDestination: async () => {
      requesterCalls += 1;
      throw new Error("an existing same-space folder must not ask the user");
    },
  });

  const result = await tool.execute({
    title: "Ship notes",
    content: "Use the existing Work folder",
    folder: " work ",
    noteType: "personal",
  });

  assert.equal(result.success, true);
  assert.equal(requesterCalls, 0);
  assert.equal(calls.createFolder.length, 0);
  assert.equal(calls.saveNote.length, 1);
  assert.equal(calls.saveNote[0][5], work.id);
  assert.equal(calls.saveNote[0][6], privateSpace.id);
  assert.equal(calls.folderReads[0], privateSpace.id);
});

test("create_note passes meeting and personal kinds to the existing default-folder policy", async (t) => {
  const calls = installElectronApi(t, {
    spaces: [privateSpace],
    folders: [
      makeFolder(11, "Personal", privateSpace.id, 1),
      makeFolder(12, "Meetings", privateSpace.id, 1),
    ],
  });
  const tool = await makeCreateTool({
    requestNoteDestination: async () => {
      throw new Error("known meeting/personal kinds use the DB default");
    },
  });

  for (const noteType of ["meeting", "personal"]) {
    const result = await tool.execute({
      title: `${noteType} note`,
      content: "content",
      noteType,
    });

    assert.equal(result.success, true);
    const saveArgs = calls.saveNote.at(-1);
    assert.equal(saveArgs[2], noteType);
    // database.saveNote selects Meetings/Personal from noteType when folderId
    // is null; the assistant must not guess a different folder ID here.
    assert.equal(saveArgs[5], null);
    assert.equal(calls.createFolder.length, 0);
  }
});

test("create_note waits for an app-owned choice on an unknown destination", async (t) => {
  const work = makeFolder(10, "Work", privateSpace.id);
  const calls = installElectronApi(t, { spaces: [privateSpace], folders: [work] });
  const gate = deferred();
  let request;
  const tool = await makeCreateTool({
    requestNoteDestination: async (received) => {
      request = received;
      return gate.promise;
    },
  });

  const resultPromise = tool.execute({
    title: "Unfiled note",
    content: "Ask the user where this belongs",
  });
  await flush();

  assert.equal(request.operation, "create");
  assert.equal(request.noteKind, "unknown");
  assert.equal(request.spaceId, privateSpace.id);
  assert.equal(request.requestedFolderName, undefined);
  assert.deepEqual(
    request.candidateFolders.map((folder) => folder.id),
    [work.id]
  );
  assert.equal(calls.createFolder.length, 0);
  assert.equal(calls.saveNote.length, 0);

  gate.resolve({ kind: "existing", folderId: work.id, spaceId: privateSpace.id });
  const result = await resultPromise;
  assert.equal(result.success, true);
  assert.equal(calls.createFolder.length, 0);
  assert.equal(calls.saveNote.length, 1);
  assert.equal(calls.saveNote[0][5], work.id);
});

test("update_note waits for explicit creation confirmation before moving a missing folder", async (t) => {
  const note = {
    id: 42,
    title: "Existing note",
    content: "Body",
    note_type: "personal",
    folder_id: 10,
    space_id: privateSpace.id,
  };
  const calls = installElectronApi(t, {
    spaces: [privateSpace],
    folders: [makeFolder(10, "Work", privateSpace.id)],
    notes: new Map([[note.id, note]]),
  });
  const gate = deferred();
  let request;
  const tool = await makeUpdateTool({
    requestNoteDestination: async (received) => {
      request = received;
      return gate.promise;
    },
  });

  const resultPromise = tool.execute({ id: note.id, folder: "Projects" });
  await flush();

  assert.equal(request.operation, "move");
  assert.equal(request.noteId, note.id);
  assert.equal(request.noteKind, "personal");
  assert.equal(request.requestedFolderName, "Projects");
  assert.equal(calls.createFolder.length, 0);
  assert.equal(calls.updateNote.length, 0);

  gate.resolve({
    kind: "created",
    folder: makeFolder(30, "Projects", privateSpace.id),
  });
  const result = await resultPromise;
  assert.equal(result.success, true);
  assert.equal(calls.createFolder.length, 0, "the confirmed UI callback owns folder creation");
  assert.equal(calls.updateNote.length, 1);
  assert.equal(calls.updateNote[0][1].folder_id, 30);
});

test("cancelled or unavailable destination choice fails closed without mutating notes", async (t) => {
  const calls = installElectronApi(t, {
    spaces: [privateSpace],
    folders: [makeFolder(10, "Work", privateSpace.id)],
  });

  const cancelledTool = await makeCreateTool({
    requestNoteDestination: async () => ({
      kind: "cancelled",
      reason: "user",
    }),
  });
  const cancelled = await cancelledTool.execute({
    title: "Cancelled",
    content: "Do not save",
    folder: "Missing",
  });
  assert.equal(cancelled.success, false);
  assert.equal(calls.createFolder.length, 0);
  assert.equal(calls.saveNote.length, 0);

  const unavailableTool = await makeCreateTool();
  const unavailable = await unavailableTool.execute({
    title: "Unavailable",
    content: "Do not save",
    folder: "Missing",
  });
  assert.equal(unavailable.success, false);
  assert.equal(calls.createFolder.length, 0);
  assert.equal(calls.saveNote.length, 0);
});

test("stale, deleted, or wrong-space callback selections cannot mutate notes", async (t) => {
  const original = makeFolder(10, "Work", privateSpace.id);
  let folderRead = 0;
  const calls = installElectronApi(t, {
    spaces: [privateSpace, teamSpace],
    folders: [original],
    getFolders: async () => {
      folderRead += 1;
      return folderRead === 1 ? [original] : [];
    },
  });
  const staleTool = await makeCreateTool({
    requestNoteDestination: async () => ({
      kind: "existing",
      folderId: original.id,
      spaceId: privateSpace.id,
    }),
  });

  const stale = await staleTool.execute({
    title: "Stale",
    content: "Folder was deleted while the dialog was open",
    folder: "Missing",
  });
  assert.equal(stale.success, false);
  assert.equal(calls.saveNote.length, 0);

  const wrongSpaceCalls = installElectronApi(t, {
    spaces: [privateSpace, teamSpace],
    folders: [original, makeFolder(20, "Other", teamSpace.id)],
  });
  const wrongSpaceTool = await makeCreateTool({
    requestNoteDestination: async () => ({
      kind: "existing",
      folderId: 20,
      spaceId: teamSpace.id,
    }),
  });
  const wrongSpace = await wrongSpaceTool.execute({
    title: "Wrong space",
    content: "Never file into another space",
    folder: "Missing",
  });
  assert.equal(wrongSpace.success, false);
  assert.equal(wrongSpaceCalls.saveNote.length, 0);
  assert.equal(wrongSpaceCalls.createFolder.length, 0);
});

test("cancellation during destination revalidation prevents a late note save", async (t) => {
  const folder = makeFolder(10, "Work", privateSpace.id);
  const revalidation = deferred();
  let reads = 0;
  const calls = installElectronApi(t, {
    spaces: [privateSpace],
    folders: [folder],
    getFolders: async () => (++reads === 1 ? [folder] : revalidation.promise),
  });
  let generation = 0;
  const tool = await makeCreateTool({
    requestNoteDestination: async () => ({
      kind: "existing",
      folderId: folder.id,
      spaceId: privateSpace.id,
    }),
    getNoteDestinationCancellationGeneration: () => generation,
  });

  const resultPromise = tool.execute({ title: "Late", content: "Do not save" });
  await flush();
  generation += 1;
  revalidation.resolve([folder]);

  const result = await resultPromise;
  assert.equal(result.success, false);
  assert.equal(calls.saveNote.length, 0);
});
