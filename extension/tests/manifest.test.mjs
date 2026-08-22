import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

test("VANTA는 엔트리 WS에만 주입된다", () => {
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://playentry.org/ws/*"]);
  assert.equal(manifest.content_scripts[0].all_frames, false);
});

test("manifest가 참조하는 파일이 모두 존재한다", () => {
  const files = [
    manifest.background.service_worker,
    ...Object.values(manifest.icons || {}),
    ...manifest.content_scripts.flatMap((item) => [...item.js, ...(item.css || [])]),
    ...manifest.web_accessible_resources.flatMap((item) => item.resources),
  ];
  for (const file of files) assert.equal(fs.existsSync(path.join(root, file)), true, file);
});

test("README 현재 버전이 manifest 버전과 일치한다", () => {
  assert.match(readme, new RegExp(`현재 개발 버전: \\*\\*${manifest.version.replaceAll(".", "\\.")}\\*\\*`));
});

test("불필요한 광범위 권한이 없다", () => {
  assert.deepEqual(manifest.permissions.sort(), ["clipboardWrite", "storage"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://playentry.org/ws/*",
    "https://llnk.kr/*",
    "https://*.firebasedatabase.app/*",
  ]);
  assert.equal(Object.hasOwn(manifest, "optional_host_permissions"), false);
});
