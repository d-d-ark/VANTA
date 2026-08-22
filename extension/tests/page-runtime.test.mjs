import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "src", "page-runtime.js"), "utf8");

function makeHarness() {
  let messageListener = null;
  const posted = [];
  const titleInput = {
    dispatchEvent() {},
  };
  class HTMLInputElement {}
  Object.defineProperty(HTMLInputElement.prototype, "value", {
    configurable: true,
    get() {
      return this.__value || "";
    },
    set(value) {
      this.__value = String(value);
    },
  });
  Object.setPrototypeOf(titleInput, HTMLInputElement.prototype);
  titleInput.value = "테스트 작품";

  function makeEntryEvent() {
    const listeners = [];
    return {
      attach(object, listener) {
        const record = { object, listener };
        listeners.push(record);
        return { destroy: () => listeners.splice(listeners.indexOf(record), 1) };
      },
      notify(...args) {
        for (const record of [...listeners]) record.listener.apply(record.object, args);
      },
    };
  }

  const entry = {
    projectId: null,
    Func: {
      isEdit: false,
      menuCode: ["stale-function-parameter"],
      resetCount: 0,
      reset() {
        this.resetCount += 1;
        this.menuCode = undefined;
      },
    },
    functionMenuDeleteCount: 0,
    exported: { objects: [{ id: "object" }], scenes: [{ id: "scene" }] },
    loaded: null,
    cleared: false,
    exportProject() {
      return structuredClone(this.exported);
    },
    clearProject() {
      this.cleared = true;
    },
    loadProject(project) {
      this.loaded = project;
    },
    getMainWS() {
      return {
        getBlockMenu: () => ({
          deleteRendered: (category) => {
            if (category === "variable") this.functionMenuDeleteCount += 1;
          },
        }),
      };
    },
    container: {
      toJSON() {},
      setObjects() {},
    },
    scene: {
      toJSON() {},
      addScenes() {},
    },
    variableContainer: {
      getVariableJSON() {},
      setVariables() {},
      setMessages() {},
      setFunctions() {},
      variableAddPanel: { isOpen: false },
      listAddPanel: { isOpen: false },
      messageAddPanel: { isOpen: false },
    },
    stage: {
      initObjectContainers() {},
    },
    commander: {
      doEvent: makeEntryEvent(),
    },
    creationChangedEvent: makeEntryEvent(),
  };
  const location = { origin: "https://playentry.org" };
  const rootClasses = new Set();
  const document = {
    documentElement: {
      classList: {
        add(value) { rootClasses.add(value); },
        remove(value) { rootClasses.delete(value); },
        contains(value) { return rootClasses.has(value); },
      },
    },
    querySelector(selector) {
      return selector.includes("#common_srch") ? titleInput : null;
    },
  };
  const window = {
    Entry: entry,
    addEventListener(type, listener) {
      if (type === "message") messageListener = listener;
    },
    postMessage(message) {
      posted.push(message);
    },
    requestAnimationFrame(callback) {
      callback();
    },
    setTimeout(callback) {
      callback();
    },
  };
  window.window = window;
  vm.runInNewContext(source, {
    window,
    document,
    location,
    HTMLInputElement,
    HTMLElement: class HTMLElement {},
    Event: class Event {},
    JSON,
    Error,
    Array,
    String,
  });

  function request(type, payload) {
    const requestId = `request-${posted.length}`;
    messageListener({
      source: window,
      origin: location.origin,
      data: { source: "vanta-content", requestId, type, payload },
    });
    return posted.findLast((message) => message.requestId === requestId);
  }
  return { entry, posted, request, rootClasses };
}

test("Entry.do 완료 이벤트는 원본 인수 없이 변경 신호만 보낸다", () => {
  const { entry, posted, request } = makeHarness();
  request("VANTA_RUNTIME_STATUS");
  entry.commander.doEvent.notify("moveBlock", { circular: entry });
  const signal = posted.findLast((message) => message.type === "VANTA_ENTRY_CHANGED");
  assert.equal(signal.commandType, "moveBlock");
  assert.equal("args" in signal, false);
});

test("코드 보드 시점 이동은 작품 변경으로 전송하지 않는다", () => {
  const { entry, posted, request } = makeHarness();
  entry.STATIC = { COMMAND_TYPES: { scrollBoard: 110 } };
  request("VANTA_RUNTIME_STATUS");
  const before = posted.filter((message) => message.type === "VANTA_ENTRY_CHANGED").length;
  entry.commander.doEvent.notify(110, [240, -80, true]);
  entry.commander.doEvent.notify("scrollBoard", [20, 10, true]);
  assert.equal(posted.filter((message) => message.type === "VANTA_ENTRY_CHANGED").length, before);
});

test("내보내는 코드 좌표는 공통 원점으로 정규화해 시점 이동을 제거한다", () => {
  const { entry, request } = makeHarness();
  entry.exported = {
    objects: [{
      id: "object",
      script: JSON.stringify([
        [{ id: "z-thread", x: 500, y: 300, type: "when_run_button_click" }],
        [{ id: "a-thread", x: 200, y: 100, type: "when_message_cast" }],
      ]),
    }],
    functions: [{
      id: "function",
      content: JSON.stringify([[{ id: "function-root", x: 640, y: 420, type: "function_create" }]]),
    }],
    scenes: [{ id: "scene" }],
  };
  const exported = request("VANTA_EXPORT_PROJECT").result;
  const objectThreads = JSON.parse(exported.objects[0].script);
  const functionThreads = JSON.parse(exported.functions[0].content);
  assert.deepEqual([objectThreads[1][0].x, objectThreads[1][0].y], [50, 30]);
  assert.deepEqual([objectThreads[0][0].x, objectThreads[0][0].y], [350, 230]);
  assert.deepEqual([functionThreads[0][0].x, functionThreads[0][0].y], [50, 30]);
});

test("Entry.exportProject 결과에 제목을 포함해 반환한다", () => {
  const { request } = makeHarness();
  const response = request("VANTA_EXPORT_PROJECT");
  assert.equal(response.ok, true);
  assert.equal(response.result.name, "테스트 작품");
  assert.equal(response.result.interface, undefined);
});

test("가져오기 전에 기존 프로젝트를 비우고 _id를 제거한다", () => {
  const { entry, request } = makeHarness();
  const response = request("VANTA_IMPORT_PROJECT", {
    project: { _id: "source-id", objects: [], scenes: [], name: "복제본" },
  });
  assert.equal(response.ok, true);
  assert.equal(entry.cleared, true);
  assert.equal(entry.loaded._id, undefined);
  assert.equal(entry.loaded.interface, undefined);
  assert.equal(entry.loaded.name, "복제본");
  assert.equal(entry.Func.menuCode, undefined);
  assert.equal(entry.Func.resetCount, 2);
  assert.equal(entry.functionMenuDeleteCount, 2);
});

test("원격 작품 적용 전후에 함수 인수 팔레트 캐시를 초기화한다", () => {
  const { entry, request } = makeHarness();

  const response = request("VANTA_IMPORT_PROJECT", {
    project: { objects: [], scenes: [], functions: [{ id: "func-a" }] },
  });

  assert.equal(response.result.applied, true);
  assert.equal(entry.Func.resetCount, 2);
  assert.equal(entry.functionMenuDeleteCount, 2);
  assert.equal(entry.Func.menuCode, undefined);
});

test("작품 실행 중에는 내보내기와 원격 덮어쓰기를 미룬다", () => {
  const { entry, request } = makeHarness();
  entry.engine = { isState: (state) => state === "run" };

  const exported = request("VANTA_EXPORT_PROJECT");
  assert.equal(exported.ok, true);
  assert.equal(exported.result.__vantaDeferred, "engine-running");

  const imported = request("VANTA_IMPORT_PROJECT", { project: { objects: [], scenes: [] } });
  assert.equal(imported.ok, true);
  assert.equal(imported.result.applied, false);
  assert.equal(entry.cleared, false);
});

test("작품 일시정지와 정지 처리 중에도 동기화를 미룬다", () => {
  for (const engineState of ["pause", "stopping"]) {
    const { entry, request } = makeHarness();
    entry.engine = {
      state: engineState,
      // EntryJS isState uses substring matching, so exact engine.state must win.
      isState: (value) => engineState.includes(value),
    };
    const exported = request("VANTA_EXPORT_PROJECT");
    assert.equal(exported.result.__vantaDeferred, "engine-running");
    assert.equal(entry.cleared, false);
  }
});

test("원격 작품 불러오기가 실패하면 기존 작품을 복구한다", () => {
  const { entry, request } = makeHarness();
  const original = structuredClone(entry.exported);
  let calls = 0;
  entry.loadProject = (project) => {
    calls += 1;
    if (calls === 1) throw new Error("broken remote project");
    entry.loaded = project;
  };

  const response = request("VANTA_IMPORT_PROJECT", { project: { objects: [], scenes: [] } });
  assert.equal(response.ok, false);
  assert.deepEqual(entry.loaded, original);
});

test("함수 편집 중에는 내보내기와 원격 덮어쓰기를 미룬다", () => {
  const { entry, request } = makeHarness();
  entry.Func.isEdit = true;

  const exported = request("VANTA_EXPORT_PROJECT");
  assert.equal(exported.ok, true);
  assert.equal(exported.result.__vantaDeferred, "function-editing");

  const imported = request("VANTA_IMPORT_PROJECT", { project: { objects: [], scenes: [] } });
  assert.equal(imported.ok, true);
  assert.equal(imported.result.applied, false);
  assert.equal(imported.result.reason, "function-editing");
  assert.equal(entry.cleared, false);
});

test("remote project import suppresses Entry transitions while rebuilding", () => {
  const { entry, request, rootClasses } = makeHarness();
  let guardedDuringLoad = false;
  entry.loadProject = (project) => {
    guardedDuringLoad = rootClasses.has("vanta-importing-project");
    entry.loaded = project;
  };

  const response = request("VANTA_IMPORT_PROJECT", { project: { objects: [], scenes: [] } });
  assert.equal(response.result.applied, true);
  assert.equal(guardedDuringLoad, true);
  assert.equal(rootClasses.has("vanta-importing-project"), false);
});

test("remote import preserves scene, object, detail tab, and active editing state", () => {
  const runtimeSource = fs.readFileSync(path.join(here, "..", "src", "page-runtime.js"), "utf8");
  assert.match(runtimeSource, /function captureEditorLocation\(entry\)/);
  assert.match(runtimeSource, /function restoreEditorLocation\(entry, location\)/);
  assert.match(runtimeSource, /entry\.scene\?\.selectedScene\?\.id/);
  assert.match(runtimeSource, /entry\.container\?\.selectedObject/);
  assert.match(runtimeSource, /entry\.playground\?\.changeViewMode/);
  assert.match(runtimeSource, /variableFilter: variableContainer\?\.viewMode_ \|\| "all"/);
  assert.match(runtimeSource, /variableContainer\.selectFilter\(location\.variableFilter\)/);
  assert.match(runtimeSource, /variableContainer\.getList\?\.\(selectedId\)/);
  assert.match(runtimeSource, /workspace\.setMode\(location\.workspaceMode/);
  assert.match(runtimeSource, /function captureCodeBoardViewport\(entry\)/);
  assert.match(runtimeSource, /function restoreCodeBoardViewport\(entry, snapshot\)/);
  assert.match(runtimeSource, /codeBoardViewport: viewMode === "code"/);
  assert.match(runtimeSource, /board\.scroller\?\._scroll\?\.\(dx, dy\)/);
  assert.match(runtimeSource, /interfaceEditing: isInterfaceEditing\(entry\)/);
  assert.match(runtimeSource, /\.\.\.selectedEditorContext\(entry\)/);
});

test("프로필 클릭 요청은 해시로 장면과 오브젝트를 찾아 선택한다", () => {
  assert.match(source, /function focusCursorContext\(entry, payload\)/);
  assert.match(source, /entry\.container\?\.getAllObjects\?\.\(\)/);
  assert.match(source, /cursorContextKey\(candidate\?\.id\) === objectKey/);
  assert.match(source, /entry\.container\?\.selectObject\?\.\(object\.id, true\)/);
  assert.match(source, /message\.type === "VANTA_FOCUS_CURSOR_CONTEXT"/);
});

test("리스트 생성 패널이 열려 있으면 인터페이스 편집 상태를 유지한다", () => {
  const { entry, request } = makeHarness();
  entry.variableContainer.listAddPanel.isOpen = true;
  const status = request("VANTA_RUNTIME_STATUS");
  assert.equal(status.result.interfaceEditing, true);
});
