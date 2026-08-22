import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "src", "project-chunks.js"), "utf8");
const context = vm.createContext({ TextEncoder, TextDecoder, Uint8Array, atob, btoa, JSON, Object, Array, Map, Set, String, Number, Math, Error });
vm.runInContext(source, context);
const chunks = context.VantaProjectChunks;
const plain = (value) => JSON.parse(JSON.stringify(value));

function sampleProject() {
  return {
    name: "sample",
    objects: [
      { id: "object-a", name: "A", script: "one" },
      { id: "object-b", name: "B", script: "two" },
    ],
    scenes: [{ id: "scene-a", name: "Scene" }],
    functions: [{ id: "function-a", content: "value" }],
    variables: [],
    messages: [],
    tables: [],
    speed: 60,
  };
}

test("a chunk bundle reconstructs the exact project", () => {
  const project = sampleProject();
  const bundle = chunks.split(project);
  assert.deepEqual(plain(chunks.assemble(bundle)), project);
});

test("editing one object sends that object instead of the whole project", () => {
  const before = chunks.split(sampleProject());
  const changedProject = sampleProject();
  changedProject.objects[1].script = "changed";
  const after = chunks.split(changedProject);
  const delta = chunks.diff(before, after);

  assert.equal(delta.removed.length, 0);
  assert.equal(Object.keys(delta.changes).length, 1);
  assert.deepEqual(plain(chunks.assemble(chunks.apply(before, delta))), changedProject);
});

test("collection order and deletions are represented by manifest and removed chunks", () => {
  const before = chunks.split(sampleProject());
  const changedProject = sampleProject();
  changedProject.objects = [changedProject.objects[1]];
  const after = chunks.split(changedProject);
  const delta = chunks.diff(before, after);

  assert.ok(delta.removed.length >= 1);
  assert.ok("manifest" in delta.changes);
  assert.deepEqual(plain(chunks.assemble(chunks.apply(before, delta))), changedProject);
});

test("a collection without stable identifiers falls back to one safe chunk", () => {
  const project = sampleProject();
  project.functions = [{ content: "first" }, { content: "second" }];
  const bundle = chunks.split(project);
  const manifest = JSON.parse(bundle.chunks.manifest);
  const descriptor = manifest.fields.find((field) => field.name === "functions");
  assert.equal(descriptor.kind, "value");
  assert.deepEqual(plain(chunks.assemble(bundle)), project);
});

test("deltas for different object IDs merge without replacing each other", () => {
  const baseProject = sampleProject();
  const base = chunks.split(baseProject);
  const leftProject = sampleProject();
  leftProject.objects[0].script = "left";
  const rightProject = sampleProject();
  rightProject.objects[1].script = "right";

  const merged = chunks.apply(
    chunks.apply(base, chunks.diff(base, chunks.split(leftProject))),
    chunks.diff(base, chunks.split(rightProject)),
  );
  const project = chunks.assemble(merged);
  assert.equal(project.objects[0].script, "left");
  assert.equal(project.objects[1].script, "right");
});

test("concurrent additions with different IDs both survive a manifest race", () => {
  const baseProject = sampleProject();
  baseProject.objects = [];
  const base = chunks.split(baseProject);
  const leftProject = structuredClone(baseProject);
  leftProject.objects.push({ id: "object-left", name: "Left", script: "left" });
  const rightProject = structuredClone(baseProject);
  rightProject.objects.push({ id: "object-right", name: "Right", script: "right" });

  const merged = chunks.apply(
    chunks.apply(base, chunks.diff(base, chunks.split(leftProject))),
    chunks.diff(base, chunks.split(rightProject)),
  );
  const ids = chunks.assemble(merged).objects.map((item) => item.id).sort();
  assert.deepEqual(plain(ids), ["object-left", "object-right"]);
});

test("an explicit item removal wins over an older order manifest", () => {
  const baseProject = sampleProject();
  const base = chunks.split(baseProject);
  const removedProject = sampleProject();
  removedProject.objects = [removedProject.objects[1]];
  const editedProject = sampleProject();
  editedProject.objects[1].script = "remote-edit";

  const merged = chunks.apply(
    chunks.apply(base, chunks.diff(base, chunks.split(removedProject))),
    chunks.diff(base, chunks.split(editedProject)),
  );
  const project = chunks.assemble(merged);
  assert.deepEqual(plain(project.objects.map((item) => item.id)), ["object-b"]);
  assert.equal(project.objects[0].script, "remote-edit");
});

test("untrusted chunk keys cannot mutate object prototypes", () => {
  const project = JSON.parse('{"objects":[],"scenes":[],"__proto__":{"polluted":true}}');
  const roundTrip = chunks.assemble(chunks.split(project));
  assert.equal(Object.hasOwn(roundTrip, "__proto__"), true);
  assert.equal({}.polluted, undefined);

  const malicious = JSON.parse('{"changes":{"__proto__":"{}"},"removed":[]}');
  assert.throws(() => chunks.validateDelta(malicious), /Invalid VANTA project delta/);
});

test("서버와 같은 작품·조각·변경 용량 제한을 요청 전에 적용한다", () => {
  const largeItem = sampleProject();
  largeItem.objects[0].script = "가".repeat(90000);
  assert.throws(() => chunks.split(largeItem), /256KB/);

  const base = chunks.split(sampleProject());
  const oversizedDelta = {
    changes: {
      item_test: JSON.stringify({ id: "test", content: "가".repeat(90000) }),
    },
    removed: [],
  };
  assert.throws(() => chunks.validateDelta(oversizedDelta), /256KB/);

  const tooMany = { changes: {}, removed: [] };
  for (let index = 0; index < 33; index += 1) tooMany.removed.push(`item_${index}`);
  assert.throws(() => chunks.validateDelta(tooMany), /32개/);
  assert.equal(chunks.assemble(base).name, "sample");
});
