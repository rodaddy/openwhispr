const test = require("node:test");
const assert = require("node:assert/strict");

let trainer;

test.before(async () => {
  trainer = await import("../../src/utils/wordTrainer.ts");
});

test("normalize trims, collapses whitespace, and strips trailing punctuation", () => {
  assert.equal(trainer.normalize("  Cooper   netties.  "), "Cooper netties");
  assert.equal(trainer.normalize("Kubernetes?!"), "Kubernetes");
});

test("a take equal to the target is not a correction", () => {
  assert.equal(trainer.takeToCorrection("Kubernetes", "Kubernetes"), null);
});

test("a case- or punctuation-only difference is not a correction", () => {
  assert.equal(trainer.takeToCorrection("  kubernetes. ", "Kubernetes"), null);
});

test("a blank take or a silence hallucination is not a correction", () => {
  assert.equal(trainer.takeToCorrection("   ", "Kubernetes"), null);
  assert.equal(trainer.takeToCorrection("Thank you.", "Kubernetes"), null);
  assert.equal(trainer.takeToCorrection("Thanks for watching!", "Kubernetes"), null);
  assert.equal(trainer.takeToCorrection("you", "Kubernetes"), null);
});

test("two differing takes give two corrections", () => {
  const takes = ["Cooper netties.", "cube or nineties"];
  const corrections = takes.map((t) => trainer.takeToCorrection(t, "Kubernetes"));
  assert.deepEqual(corrections, [
    { trigger: "Cooper netties", replacement: "Kubernetes" },
    { trigger: "cube or nineties", replacement: "Kubernetes" },
  ]);
});

test("duplicate takes merge into one snippet", () => {
  const result = trainer.mergeCorrections(
    [],
    [
      { trigger: "Cooper netties", replacement: "Kubernetes" },
      { trigger: "cooper NETTIES", replacement: "Kubernetes" },
    ]
  );
  assert.deepEqual(result.snippets, [{ trigger: "Cooper netties", replacement: "Kubernetes" }]);
  assert.deepEqual(result.added, ["Cooper netties"]);
  assert.deepEqual(result.replaced, []);
});

test("an existing trigger is replaced and reported; untouched snippets keep their order", () => {
  const existing = [
    { trigger: "brb", replacement: "be right back" },
    { trigger: "cooper netties", replacement: "Kubernets" },
    { trigger: "sig", replacement: "Rico" },
  ];
  const result = trainer.mergeCorrections(existing, [
    { trigger: "Cooper netties", replacement: "Kubernetes" },
    { trigger: "cube or nineties", replacement: "Kubernetes" },
  ]);
  assert.deepEqual(result.snippets, [
    { trigger: "brb", replacement: "be right back" },
    { trigger: "cooper netties", replacement: "Kubernetes" },
    { trigger: "sig", replacement: "Rico" },
    { trigger: "cube or nineties", replacement: "Kubernetes" },
  ]);
  assert.deepEqual(result.replaced, ["cooper netties"]);
  assert.deepEqual(result.added, ["cube or nineties"]);
  assert.equal(existing[1].replacement, "Kubernets");
});

test("a correction never overwrites a snippet the matcher keys differently", () => {
  const existing = [{ trigger: "addr.", replacement: "123 Main St" }];
  const result = trainer.mergeCorrections(existing, [{ trigger: "addr", replacement: "address" }]);
  assert.deepEqual(result.snippets, [
    { trigger: "addr.", replacement: "123 Main St" },
    { trigger: "addr", replacement: "address" },
  ]);
  assert.deepEqual(result.added, ["addr"]);
  assert.deepEqual(result.replaced, []);
});

test("İ/i and NFD/NFC triggers dedupe to the matcher's one key", () => {
  const result = trainer.mergeCorrections(
    [{ trigger: "İmza", replacement: "old" }],
    [
      { trigger: "İmza", replacement: "Signature" },
      { trigger: "imza", replacement: "other" },
      { trigger: "i", replacement: "A" },
      { trigger: "İ", replacement: "B" },
    ]
  );
  assert.deepEqual(result.snippets, [
    { trigger: "İmza", replacement: "Signature" },
    { trigger: "i", replacement: "A" },
  ]);
  assert.deepEqual(result.replaced, ["İmza"]);
  assert.deepEqual(result.added, ["i"]);
});
