(() => {
  "use strict";

  if (window.__vantaPageRuntimeLoaded) return;
  window.__vantaPageRuntimeLoaded = true;

  const CONTENT_SOURCE = "vanta-content";
  const PAGE_SOURCE = "vanta-page";
  const commandObserver = {};
  let observedDoEvent = null;
  let observedDoListener = null;
  let observedCreationEvent = null;
  let observedCreationListener = null;
  let projectImportMotionGeneration = 0;

  function notifyEntryChanged(commandType = null) {
    window.postMessage({
      source: PAGE_SOURCE,
      type: "VANTA_ENTRY_CHANGED",
      commandType: ["string", "number"].includes(typeof commandType) ? commandType : null,
    }, location.origin);
  }

  function isLocalViewCommand(entry, commandType) {
    const scrollBoard = entry?.STATIC?.COMMAND_TYPES?.scrollBoard;
    return commandType === "scrollBoard"
      || (Number.isFinite(scrollBoard) && commandType === scrollBoard);
  }

  function ensureCommandObserver(entry) {
    const doEvent = entry?.commander?.doEvent;
    if (doEvent && typeof doEvent.attach === "function" && doEvent !== observedDoEvent) {
      observedDoListener?.destroy?.();
      observedDoEvent = doEvent;
      observedDoListener = doEvent.attach(commandObserver, (commandType) => {
        if (!isLocalViewCommand(entry, commandType)) notifyEntryChanged(commandType);
      });
    }
    const creationEvent = entry?.creationChangedEvent;
    if (creationEvent && typeof creationEvent.attach === "function" && creationEvent !== observedCreationEvent) {
      observedCreationListener?.destroy?.();
      observedCreationEvent = creationEvent;
      observedCreationListener = creationEvent.attach(commandObserver, () => notifyEntryChanged());
    }
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function roundCodeCoordinate(value) {
    const rounded = Math.round(Number(value) * 1000000) / 1000000;
    return Object.is(rounded, -0) ? 0 : rounded;
  }

  function normalizeCodeOrigin(serialized) {
    if (typeof serialized !== "string" || !serialized) return serialized;
    try {
      const threads = JSON.parse(serialized);
      if (!Array.isArray(threads)) return serialized;
      const heads = threads
        .map((thread, index) => ({ head: Array.isArray(thread) ? thread[0] : null, index }))
        .filter(({ head }) => head && Number.isFinite(Number(head.x)) && Number.isFinite(Number(head.y)));
      if (!heads.length) return serialized;
      const preferred = heads.filter(({ head }) => head.type !== "comment" && head.display !== false);
      const anchor = (preferred.length ? preferred : heads)
        .slice()
        .sort((left, right) => String(left.head.id || "").localeCompare(String(right.head.id || ""))
          || left.index - right.index)[0]?.head;
      if (!anchor) return serialized;
      const offsetX = Number(anchor.x) - 50;
      const offsetY = Number(anchor.y) - 30;
      for (const { head } of heads) {
        head.x = roundCodeCoordinate(Number(head.x) - offsetX);
        head.y = roundCodeCoordinate(Number(head.y) - offsetY);
      }
      return JSON.stringify(threads);
    } catch (_) {
      // Unofficial blocks may use a nonstandard payload. Preserve it byte-for-byte.
      return serialized;
    }
  }

  function getEntry() {
    const entry = window.Entry;
    const ready = entry
      && typeof entry.exportProject === "function"
      && typeof entry.loadProject === "function"
      && typeof entry.clearProject === "function"
      && typeof entry.container?.toJSON === "function"
      && typeof entry.container?.setObjects === "function"
      && typeof entry.scene?.toJSON === "function"
      && typeof entry.scene?.addScenes === "function"
      && typeof entry.variableContainer?.getVariableJSON === "function"
      && typeof entry.variableContainer?.setVariables === "function"
      && typeof entry.variableContainer?.setMessages === "function"
      && typeof entry.variableContainer?.setFunctions === "function"
      && typeof entry.stage?.initObjectContainers === "function";
    if (!ready) return null;
    ensureCommandObserver(entry);
    return entry;
  }

  function currentTitle() {
    const input = document.querySelector("#common_srch input[maxlength='30']");
    return input instanceof HTMLInputElement ? input.value.trim() : "";
  }

  function normalizeProject(rawProject) {
    const project = cloneJson(rawProject);
    delete project._id;
    delete project.interface;
    for (const object of project.objects || []) {
      if (object && typeof object.script === "string") object.script = normalizeCodeOrigin(object.script);
    }
    for (const func of project.functions || []) {
      if (func && typeof func.content === "string") func.content = normalizeCodeOrigin(func.content);
    }
    return project;
  }

  function setProjectTitle(title) {
    const input = document.querySelector("#common_srch input[maxlength='30']");
    if (!title || !(input instanceof HTMLInputElement)) return;
    const value = String(title).slice(0, 30);
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (nativeSetter) nativeSetter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isEngineActive(entry) {
    const engineState = typeof entry.engine?.state === "string" ? entry.engine.state : "";
    if (engineState) return engineState !== "stop";
    if (typeof entry.engine?.isState === "function") {
      if (entry.engine.isState("run") || entry.engine.isState("pause") || entry.engine.isState("stopping")) return true;
    }
    const stopButton = document.querySelector(".entryStopButtonWorkspace_w");
    const startButton = document.querySelector(".entryRunButtonWorkspace_w");
    const visible = (element) => {
      if (!(element instanceof HTMLElement) || element.classList.contains("entryRemove")) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    if (visible(startButton)) return false;
    if (visible(stopButton)) return true;
    return false;
  }

  function isFunctionEditing(entry) {
    return entry.Func?.isEdit === true;
  }

  function selectedEditorContext(entry) {
    const object = entry?.container?.selectedObject || entry?.playground?.object || null;
    return {
      sceneId: entry?.scene?.selectedScene?.id || null,
      objectId: object?.id || null,
    };
  }

  function cursorContextKey(value) {
    const text = String(value || "");
    if (!text) return "";
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
  }

  function focusCursorContext(entry, payload) {
    if (isEngineActive(entry)) return { focused: false, reason: "engine-running" };
    const sceneKey = String(payload?.sceneKey || "").slice(0, 6);
    const objectKey = String(payload?.objectKey || "").slice(0, 6);
    const scenes = entry.scene?.getScenes?.() || [];
    const objects = entry.container?.getAllObjects?.() || [];
    const object = objectKey
      ? objects.find((candidate) => cursorContextKey(candidate?.id) === objectKey)
      : null;
    const scene = object?.scene || (sceneKey
      ? scenes.find((candidate) => cursorContextKey(candidate?.id) === sceneKey)
      : null);
    if (!object && !scene) return { focused: false, reason: "context-not-found" };

    if (scene) entry.scene?.selectScene?.(scene);
    if (object) {
      entry.container?.selectObject?.(object.id, true);
      entry.container?.scrollToObject?.(object.id);
    } else {
      scene?.view?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }

    const area = String(payload?.area || "");
    if (area === "properties") entry.playground?.changeViewMode?.("variable");
    else if (["codeboard", "blockmenu", "playground"].includes(area)) {
      entry.playground?.changeViewMode?.("code");
    }
    return {
      focused: true,
      sceneId: scene?.id || null,
      objectId: object?.id || null,
    };
  }

  function isInterfaceEditing(entry = window.Entry) {
    const variableContainer = entry?.variableContainer;
    if ([
      variableContainer?.variableAddPanel,
      variableContainer?.listAddPanel,
      variableContainer?.messageAddPanel,
    ].some((panel) => panel?.isOpen === true)) return true;
    if (document.querySelector(
      ".entryVariableAddSpaceWorkspace:not(.off), .message_inpt:not(.off)"
    )) return true;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body) return false;
    if (active.closest?.("#vanta-root, #vanta-chat")) return false;
    return active.matches("input, textarea, select, [contenteditable='true']");
  }

  function captureCodeBoardViewport(entry) {
    const workspace = entry.getMainWS?.();
    const board = workspace?.getBoard?.();
    const threads = board?.code?.getThreads?.();
    if (!board || !Array.isArray(threads)) return null;
    const anchors = threads.map((thread) => {
      const block = thread?.getFirstBlock?.();
      const view = block?.view;
      if (!block?.id || !view?.display
        || !Number.isFinite(Number(view.x)) || !Number.isFinite(Number(view.y))) return null;
      return { id: String(block.id), x: Number(view.x), y: Number(view.y) };
    }).filter(Boolean);
    if (!anchors.length) return null;
    return {
      scale: Number(workspace.scale || board.scale || 1),
      anchors: anchors.sort((left, right) => left.id.localeCompare(right.id)).slice(0, 16),
    };
  }

  function restoreCodeBoardViewport(entry, snapshot) {
    if (!snapshot?.anchors?.length) return;
    const workspace = entry.getMainWS?.();
    const board = workspace?.getBoard?.();
    if (!board?.code) return;
    const scale = Number(snapshot.scale);
    if (Number.isFinite(scale) && scale > 0 && workspace?.setScale
      && Math.abs(Number(workspace.scale || 1) - scale) > 0.0001) {
      workspace.setScale(scale);
    }
    for (const saved of snapshot.anchors) {
      const block = board.findById?.(saved.id);
      const view = block?.view;
      if (!view || !Number.isFinite(Number(view.x)) || !Number.isFinite(Number(view.y))) continue;
      const dx = Number(saved.x) - Number(view.x);
      const dy = Number(saved.y) - Number(view.y);
      if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
        board.scroller?._scroll?.(dx, dy);
        board.scroller?.resizeScrollBar?.();
      }
      return;
    }
  }

  function captureEditorLocation(entry) {
    const object = entry.container?.selectedObject || entry.playground?.object || null;
    const variableContainer = entry.variableContainer;
    const selectedVariable = variableContainer?.selected || null;
    const viewMode = entry.playground?.getViewMode?.() || entry.playground?.viewMode_ || "code";
    const scrollSelectors = [
      ".entrySceneListWorkspace",
      ".entryObjectListWorkspace",
      ".entryPlaygroundCodeWorkspace",
      ".entryPlaygroundPictureWorkspace",
      ".entryPlaygroundSoundWorkspace",
      ".entryVariablePanelWorkspace",
    ];
    return {
      sceneId: entry.scene?.selectedScene?.id || null,
      objectId: object?.id || null,
      viewMode,
      workspaceMode: entry.getMainWS?.()?.getMode?.() ?? null,
      variableFilter: variableContainer?.viewMode_ || "all",
      selectedVariableType: selectedVariable?.type || "",
      selectedVariableId: selectedVariable?.id || selectedVariable?.id_ || selectedVariable?.getId?.() || "",
      pictureId: object?.selectedPicture?.id || null,
      soundId: object?.selectedSound?.id || null,
      codeBoardViewport: viewMode === "code" ? captureCodeBoardViewport(entry) : null,
      scroll: scrollSelectors.map((selector) => {
        const element = document.querySelector(selector);
        return element ? { selector, left: element.scrollLeft, top: element.scrollTop } : null;
      }).filter(Boolean),
    };
  }

  function restoreEditorLocation(entry, location) {
    if (!location) return;
    try {
      const scene = location.sceneId && entry.scene?.getSceneById?.(location.sceneId);
      if (scene) entry.scene.selectScene(scene);
      const object = location.objectId && entry.container?.getObject?.(location.objectId);
      if (object) entry.container.selectObject(object.id, true);
      if (object && ["code", "picture", "text", "sound", "variable"].includes(location.viewMode)) {
        entry.playground?.changeViewMode?.(location.viewMode);
      }
      const workspace = entry.getMainWS?.();
      if (location.workspaceMode !== null && workspace?.setMode
        && workspace.getMode?.() !== location.workspaceMode) {
        workspace.setMode(location.workspaceMode, undefined, true);
      }
      const variableContainer = entry.variableContainer;
      if (location.viewMode === "variable" && variableContainer?.selectFilter
        && ["all", "variable", "list", "message", "func"].includes(location.variableFilter)) {
        variableContainer.selectFilter(location.variableFilter);
        const selectedId = location.selectedVariableId;
        const selected = location.selectedVariableType === "list"
          ? variableContainer.getList?.(selectedId)
          : location.selectedVariableType === "variable"
            ? variableContainer.getVariable?.(selectedId)
            : location.variableFilter === "message"
              ? variableContainer.getMessage?.(selectedId)
              : location.variableFilter === "func"
                ? variableContainer.functions_?.[selectedId]
                : null;
        if (selected) variableContainer.select?.(selected);
      }
      if (object && location.pictureId && object.getPicture?.(location.pictureId)) {
        entry.container.selectPicture(location.pictureId, object.id);
      }
      if (object && location.soundId && object.getSound?.(location.soundId)) {
        entry.container.selectSound(location.soundId, object.id);
      }
      for (const saved of location.scroll || []) {
        const element = document.querySelector(saved.selector);
        if (element) {
          element.scrollLeft = saved.left;
          element.scrollTop = saved.top;
        }
      }
      restoreCodeBoardViewport(entry, location.codeBoardViewport);
    } catch (_) {
      // A remotely deleted scene/object cannot be restored; Entry's first valid item stays selected.
    }
  }

  function resetFunctionMenuCache(entry) {
    if (!entry?.Func || isFunctionEditing(entry)) return;
    if (typeof entry.Func.reset === "function") entry.Func.reset();
    else entry.Func.menuCode = undefined;
    const workspace = typeof entry.getMainWS === "function" ? entry.getMainWS() : entry.mainWorkspace;
    const blockMenu = typeof workspace?.getBlockMenu === "function" ? workspace.getBlockMenu() : workspace?.blockMenu;
    blockMenu?.deleteRendered?.("variable");
  }

  function beginProjectImportMotionGuard() {
    const root = document.documentElement;
    const generation = ++projectImportMotionGeneration;
    root?.classList?.add?.("vanta-importing-project");
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remove = () => {
        if (generation === projectImportMotionGeneration) root?.classList?.remove?.("vanta-importing-project");
      };
      const settle = () => {
        if (typeof window.setTimeout === "function") window.setTimeout(remove, 160);
        else remove();
      };
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => window.requestAnimationFrame(settle));
      } else {
        settle();
      }
    };
  }

  function exportProject() {
    const entry = getEntry();
    if (!entry) throw new Error("엔트리 편집기가 아직 준비되지 않았습니다.");
    if (isEngineActive(entry)) {
      return { __vantaDeferred: "engine-running" };
    }
    if (isFunctionEditing(entry)) {
      return { __vantaDeferred: "function-editing" };
    }
    const project = normalizeProject(entry.exportProject({}));
    if (!project?.objects || !project?.scenes) throw new Error("엔트리 작품 상태를 읽지 못했습니다.");
    if (currentTitle() && !project.name) project.name = currentTitle();
    return cloneJson(project);
  }

  function importProject(rawProject, preserveInterface) {
    const entry = getEntry();
    if (!entry) throw new Error("엔트리 편집기가 아직 준비되지 않았습니다.");
    if (isEngineActive(entry)) {
      return { applied: false, reason: "engine-running" };
    }
    if (isFunctionEditing(entry)) {
      return { applied: false, reason: "function-editing" };
    }
    if (!rawProject || !Array.isArray(rawProject.objects) || !Array.isArray(rawProject.scenes)) {
      throw new Error("올바른 엔트리 작품 데이터가 아닙니다.");
    }

    const project = normalizeProject(rawProject);
    const backupProject = normalizeProject(entry.exportProject({}));
    const localInterface = preserveInterface && typeof entry.captureInterfaceState === "function"
      ? cloneJson(entry.captureInterfaceState())
      : null;
    const editorLocation = preserveInterface ? captureEditorLocation(entry) : null;
    const releaseMotionGuard = beginProjectImportMotionGuard();
    try {
      // Entry caches the function parameter palette separately from project data. If a
      // remote load keeps that cache, old and new argument blocks are rendered together.
      resetFunctionMenuCache(entry);
      try {
        entry.clearProject();
        entry.loadProject(project);
      } catch (error) {
        try {
          entry.clearProject();
          entry.loadProject(backupProject);
        } catch (_) {
          // Preserve the original load error; a second failure means Entry itself can no
          // longer restore the previously exported model safely.
        }
        resetFunctionMenuCache(entry);
        throw error;
      }
      resetFunctionMenuCache(entry);
      if (localInterface && typeof entry.loadInterfaceState === "function") {
        entry.loadInterfaceState(localInterface);
      }
      if (editorLocation) {
        restoreEditorLocation(entry, editorLocation);
        window.setTimeout(() => restoreEditorLocation(entry, editorLocation), 0);
        window.setTimeout(() => restoreEditorLocation(entry, editorLocation), 120);
      }

      setProjectTitle(project.name);
      return { applied: true };
    } finally {
      releaseMotionGuard();
    }
  }

  function respond(requestId, ok, result, error) {
    window.postMessage({
      source: PAGE_SOURCE,
      requestId,
      ok,
      result,
      error,
    }, location.origin);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data || {};
    if (message.source !== CONTENT_SOURCE || !message.requestId) return;

    try {
      if (message.type === "VANTA_RUNTIME_STATUS") {
        const entry = getEntry();
        respond(message.requestId, true, {
          ready: Boolean(entry),
          projectId: window.Entry?.projectId || null,
          interfaceEditing: isInterfaceEditing(entry),
          ...selectedEditorContext(entry),
        });
        return;
      }
      if (message.type === "VANTA_EXPORT_PROJECT") {
        respond(message.requestId, true, exportProject());
        return;
      }
      if (message.type === "VANTA_IMPORT_PROJECT") {
        respond(message.requestId, true, importProject(message.payload?.project, message.payload?.preserveInterface === true));
        return;
      }
      if (message.type === "VANTA_FOCUS_CURSOR_CONTEXT") {
        const entry = getEntry();
        respond(message.requestId, true, focusCursorContext(entry, message.payload));
        return;
      }
      respond(message.requestId, false, null, "지원하지 않는 VANTA 요청입니다.");
    } catch (error) {
      respond(message.requestId, false, null, error?.message || "엔트리 작품 처리 중 오류가 발생했습니다.");
    }
  });

  window.postMessage({ source: PAGE_SOURCE, type: "VANTA_RUNTIME_ATTACHED" }, location.origin);
  if (typeof window.setInterval === "function") {
    window.setInterval(() => ensureCommandObserver(window.Entry), 500);
  }
})();
