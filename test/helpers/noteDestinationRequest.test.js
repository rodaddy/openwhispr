const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("a stale response cannot settle a newer destination request", async () => {
  const { NoteDestinationRequestController } =
    await import("../../src/hooks/useNoteDestinationRequest.ts");
  const controller = new NoteDestinationRequestController();
  const request = { operation: "create", noteKind: "unknown", spaceId: 1, candidateFolders: [] };
  const first = controller.request(request);
  const firstId = controller.pending.id;
  controller.cancel("cancelled");
  const second = controller.request(request);
  const secondId = controller.pending.id;

  controller.settle(firstId, { kind: "created", folder: { id: 10, name: "Old", space_id: 1 } });
  assert.equal(controller.pending.id, secondId);
  controller.settle(secondId, { kind: "cancelled", reason: "done" });

  assert.equal((await first).kind, "cancelled");
  assert.equal((await second).kind, "cancelled");
});

test("folder creation suppresses repeat calls and reports rejected creation", async () => {
  const { runNoteFolderCreation } = await import("../../src/services/tools/noteDestination.ts");
  let resolveCreate;
  let calls = 0;
  const errors = [];
  const lock = { current: false };
  const first = runNoteFolderCreation({
    lock,
    create: () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveCreate = resolve;
      });
    },
    onSuccess: () => {},
    onError: (message) => errors.push(message),
  });
  const repeated = await runNoteFolderCreation({
    lock,
    create: async () => {
      calls += 1;
    },
    onSuccess: () => {},
    onError: (message) => errors.push(message),
  });
  assert.equal(repeated, false);
  assert.equal(calls, 1);
  resolveCreate({ success: false, error: "Folder rejected" });
  await first;
  assert.deepEqual(errors, ["Folder rejected"]);

  await runNoteFolderCreation({
    lock,
    create: async () => {
      throw new Error("Network failed");
    },
    onSuccess: () => {},
    onError: (message) => errors.push(message),
  });
  assert.deepEqual(errors, ["Folder rejected", "Network failed"]);
});

test("every note destination host remounts request-local UI state for a new request", () => {
  for (const relativePath of [
    "../../src/components/chat/ChatView.tsx",
    "../../src/components/dictation/AssistantPanel.tsx",
  ]) {
    const source = fs.readFileSync(path.join(__dirname, relativePath), "utf8");
    assert.match(
      source,
      /<NoteDestinationDialog\s+key=\{noteDestination\.pending\?\.id \?\? "no-note-destination"\}/,
      `${relativePath} must isolate dialog refs and state by request ID`
    );
  }
});

test("an exact spoken folder reply settles only the active destination request", async () => {
  const { NoteDestinationRequestController } =
    await import("../../src/hooks/useNoteDestinationRequest.ts");
  const controller = new NoteDestinationRequestController();
  const work = { id: 10, name: "Work", space_id: 1 };
  const resultPromise = controller.request({
    operation: "create",
    noteKind: "unknown",
    spaceId: 1,
    candidateFolders: [work],
  });

  assert.equal(controller.resolveVoiceCommand("use Work"), true);
  assert.deepEqual(await resultPromise, {
    kind: "existing",
    folderId: work.id,
    spaceId: work.space_id,
  });
  assert.equal(controller.pending, null);
});

test("terminal ASR punctuation is ignored for folder selection without hiding collisions", async () => {
  const { NoteDestinationRequestController } =
    await import("../../src/hooks/useNoteDestinationRequest.ts");
  const personal = { id: 10, name: "Personal", space_id: 1 };
  const controller = new NoteDestinationRequestController();
  const selected = controller.request({
    operation: "create",
    noteKind: "unknown",
    spaceId: 1,
    candidateFolders: [personal],
  });

  assert.equal(controller.resolveVoiceCommand("Personal."), true);
  assert.deepEqual(await selected, {
    kind: "existing",
    folderId: personal.id,
    spaceId: personal.space_id,
  });

  const ambiguous = controller.request({
    operation: "create",
    noteKind: "unknown",
    spaceId: 1,
    candidateFolders: [personal, { id: 11, name: "Personal.", space_id: 1 }],
  });
  assert.equal(controller.resolveVoiceCommand("Personal."), true);
  assert.ok(controller.pending);
  controller.cancel("test");
  assert.deepEqual(await ambiguous, { kind: "cancelled", reason: "test" });
});

test("terminal ASR punctuation is ignored for confirmation and cancellation commands", async () => {
  const { NoteDestinationRequestController } =
    await import("../../src/hooks/useNoteDestinationRequest.ts");
  const controller = new NoteDestinationRequestController(async (name, spaceId) => ({
    success: true,
    folder: { id: 12, name, space_id: spaceId },
  }));
  const confirmed = controller.request({
    operation: "create",
    noteKind: "unknown",
    spaceId: 1,
    requestedFolderName: "Projects",
    candidateFolders: [],
  });
  assert.equal(controller.resolveVoiceCommand("Yes."), true);
  assert.deepEqual(await confirmed, {
    kind: "created",
    folder: { id: 12, name: "Projects", space_id: 1 },
  });

  const cancelled = controller.request({
    operation: "create",
    noteKind: "unknown",
    spaceId: 1,
    candidateFolders: [],
  });
  assert.equal(controller.resolveVoiceCommand("Cancel."), true);
  assert.deepEqual(await cancelled, { kind: "cancelled", reason: "voice-cancelled" });
});

test("a spoken creation proposal strips only terminal ASR punctuation", async () => {
  const { NoteDestinationRequestController } =
    await import("../../src/hooks/useNoteDestinationRequest.ts");
  const controller = new NoteDestinationRequestController();
  const resultPromise = controller.request({
    operation: "create",
    noteKind: "unknown",
    spaceId: 1,
    candidateFolders: [],
  });

  assert.equal(controller.resolveVoiceCommand("create folder Client: Projects."), true);
  assert.equal(controller.pending.request.requestedFolderName, "Client: Projects");
  controller.cancel("test");
  assert.deepEqual(await resultPromise, { kind: "cancelled", reason: "test" });
});

test("an unrecognized spoken follow-up is consumed and leaves the destination pending", async () => {
  const { NoteDestinationRequestController } =
    await import("../../src/hooks/useNoteDestinationRequest.ts");
  const controller = new NoteDestinationRequestController();
  const resultPromise = controller.request({
    operation: "create",
    noteKind: "unknown",
    spaceId: 1,
    candidateFolders: [],
  });

  assert.equal(controller.resolveVoiceCommand("summarize that"), true);
  assert.ok(controller.pending);
  controller.cancel("test");
  assert.deepEqual(await resultPromise, { kind: "cancelled", reason: "test" });
});

test("a spoken new-folder proposal only fills the existing confirmation UI", async () => {
  const { NoteDestinationRequestController } =
    await import("../../src/hooks/useNoteDestinationRequest.ts");
  const controller = new NoteDestinationRequestController();
  const resultPromise = controller.request({
    operation: "create",
    noteKind: "unknown",
    spaceId: 1,
    candidateFolders: [],
  });

  assert.equal(controller.resolveVoiceCommand("create folder Projects"), true);
  assert.equal(controller.pending.request.requestedFolderName, "Projects");
  controller.settle(controller.pending.id, {
    kind: "cancelled",
    reason: "confirmation-not-clicked",
  });
  assert.deepEqual(await resultPromise, {
    kind: "cancelled",
    reason: "confirmation-not-clicked",
  });
});

test("an ambiguous spoken folder name stays pending for explicit UI choice", async () => {
  const { NoteDestinationRequestController } =
    await import("../../src/hooks/useNoteDestinationRequest.ts");
  const controller = new NoteDestinationRequestController();
  const resultPromise = controller.request({
    operation: "create",
    noteKind: "unknown",
    spaceId: 1,
    candidateFolders: [
      { id: 10, name: "Work", space_id: 1 },
      { id: 11, name: "Work", space_id: 1 },
    ],
  });

  assert.equal(controller.resolveVoiceCommand("Work"), true);
  assert.ok(controller.pending);
  controller.cancel("ambiguous");
  assert.deepEqual(await resultPromise, { kind: "cancelled", reason: "ambiguous" });
});

test("a confirmed spoken folder proposal creates once through the shared boundary", async () => {
  const { NoteDestinationRequestController } =
    await import("../../src/hooks/useNoteDestinationRequest.ts");
  let calls = 0;
  let releaseCreation;
  const controller = new NoteDestinationRequestController(
    () =>
      new Promise((resolve) => {
        calls += 1;
        releaseCreation = resolve;
      })
  );
  const resultPromise = controller.request({
    operation: "create",
    noteKind: "unknown",
    spaceId: 1,
    candidateFolders: [],
  });

  assert.equal(controller.resolveVoiceCommand("create folder Projects"), true);
  assert.equal(controller.resolveVoiceCommand("confirm"), true);
  assert.equal(controller.resolveVoiceCommand("yes"), true);
  assert.equal(calls, 1);
  releaseCreation({ success: true, folder: { id: 12, name: "Projects", space_id: 1 } });

  assert.deepEqual(await resultPromise, {
    kind: "created",
    folder: { id: 12, name: "Projects", space_id: 1 },
  });
});

test("cancelled creation cannot settle a later request", async () => {
  const { NoteDestinationRequestController } =
    await import("../../src/hooks/useNoteDestinationRequest.ts");
  let releaseCreation;
  const controller = new NoteDestinationRequestController(
    () => new Promise((resolve) => (releaseCreation = resolve))
  );
  const first = controller.request({
    operation: "create",
    noteKind: "unknown",
    spaceId: 1,
    requestedFolderName: "Projects",
    candidateFolders: [],
  });
  assert.equal(controller.resolveVoiceCommand("yes"), true);
  controller.cancel("voice-cancelled");
  const second = controller.request({
    operation: "create",
    noteKind: "unknown",
    spaceId: 2,
    candidateFolders: [],
  });
  releaseCreation({ success: true, folder: { id: 12, name: "Projects", space_id: 1 } });

  assert.deepEqual(await first, { kind: "cancelled", reason: "voice-cancelled" });
  assert.equal(controller.pending.request.spaceId, 2);
  controller.cancel("test");
  assert.deepEqual(await second, { kind: "cancelled", reason: "test" });
});

test("in-flight creation consumes other destination replies without changing its proposal", async () => {
  const { NoteDestinationRequestController } =
    await import("../../src/hooks/useNoteDestinationRequest.ts");
  let releaseCreation;
  const controller = new NoteDestinationRequestController(
    () => new Promise((resolve) => (releaseCreation = resolve))
  );
  const existing = { id: 20, name: "Work", space_id: 1 };
  const resultPromise = controller.request({
    operation: "create",
    noteKind: "unknown",
    spaceId: 1,
    candidateFolders: [existing],
  });

  controller.resolveVoiceCommand("create folder Projects");
  controller.resolveVoiceCommand("yes");
  const requestId = controller.pending.id;
  assert.equal(controller.resolveVoiceCommand("use Work"), true);
  assert.equal(controller.resolveVoiceCommand("create folder Other"), true);
  assert.equal(controller.resolveVoiceCommand("confirm"), true);
  controller.resolveUserResult(requestId, {
    kind: "existing",
    folderId: existing.id,
    spaceId: existing.space_id,
  });
  assert.equal(await controller.confirmFolderCreation("Dialog folder"), false);
  assert.equal(controller.pending.request.requestedFolderName, "Projects");
  assert.equal(controller.pending.creating, true);

  releaseCreation({ success: true, folder: { id: 21, name: "Projects", space_id: 1 } });
  assert.deepEqual(await resultPromise, {
    kind: "created",
    folder: { id: 21, name: "Projects", space_id: 1 },
  });
});

test("dialog cancellation is the only accepted user result during creation", async () => {
  const { NoteDestinationRequestController } =
    await import("../../src/hooks/useNoteDestinationRequest.ts");
  let releaseCreation;
  const controller = new NoteDestinationRequestController(
    () => new Promise((resolve) => (releaseCreation = resolve))
  );
  const resultPromise = controller.request({
    operation: "create",
    noteKind: "unknown",
    spaceId: 1,
    requestedFolderName: "Projects",
    candidateFolders: [],
  });
  controller.resolveVoiceCommand("yes");
  const requestId = controller.pending.id;
  controller.resolveUserResult(requestId, { kind: "cancelled", reason: "user" });
  releaseCreation({ success: true, folder: { id: 21, name: "Projects", space_id: 1 } });

  assert.deepEqual(await resultPromise, { kind: "cancelled", reason: "user" });
  assert.equal(controller.cancellationGeneration, 1);
  assert.equal(controller.pending, null);
});

test("panel destination cancellation distinguishes entrance from an actual close", async () => {
  const { getPanelCloseCancellation } =
    await import("../../src/hooks/useNoteDestinationRequest.ts");

  assert.equal(getPanelCloseCancellation(false, false), null, "entrance before open stays pending");
  assert.equal(getPanelCloseCancellation(false, true), null);
  assert.equal(getPanelCloseCancellation(true, false), "panel-closed");
});

test("without a pending destination, voice resolution leaves normal chat dispatch available", async () => {
  const { NoteDestinationRequestController } =
    await import("../../src/hooks/useNoteDestinationRequest.ts");
  const controller = new NoteDestinationRequestController();
  assert.equal(controller.resolveVoiceCommand("summarize that"), false);
});

test("the recording command path resolves a pending destination before normal assistant dispatch", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/App.jsx"), "utf8");
  assert.match(
    source,
    /if \(resolveNoteDestinationVoiceCommand\(command\.text\)\) return;\s+handleAssistantPanelCommand\(command\);/
  );
  assert.match(source, /onAssistantCommand: handleAssistantCommand/);
  assert.match(source, /<AssistantPanel[\s\S]*noteDestination=\{noteDestination\}/);
});
