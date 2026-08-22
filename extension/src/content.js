(() => {
  "use strict";

  if (window.__vantaContentLoaded || window.self !== window.top) return;
  window.__vantaContentLoaded = true;

  const PAGE_SOURCE = "vanta-page";
  const CONTENT_SOURCE = "vanta-content";
  const SYNC_CHECK_INTERVAL_MS = 500;
  const PROJECT_SYNC_IDLE_MS = 1800;
  const PROJECT_SYNC_MAX_WAIT_MS = 8000;
  const COMMAND_SYNC_DEBOUNCE_MS = 250;
  const REMOTE_POLL_INTERVAL_MS = 5000;
  const FULL_RECOVERY_MIN_INTERVAL_MS = 5000;
  const LIVE_HEARTBEAT_MS = 5000;
  const CHAT_MAX_LENGTH = 100;
  const CHAT_HISTORY_LIMIT = 20;
  const CHAT_POSITION_VERSION = 3;
  const LIVE_CURSOR_INTERVAL_MS = 100;
  const CURSOR_KEEPALIVE_INTERVAL_MS = 2000;
  const CURSOR_CONTEXT_INTERVAL_MS = 200;
  const MAX_PENDING_PROJECT_CHANGES = 64;
  const MAX_PENDING_PROJECT_BYTES = 4 * 1024 * 1024;
  const UI_SETTINGS_KEY = "vanta.uiSettings";
  const TUTORIAL_COMPLETED_KEY = "vanta.tutorialCompleted.v1";
  const PROFILE_COLOR_PALETTE = [
    "#FF6B6B", "#FF9F43", "#F4C542", "#72C850", "#2FCB9B",
    "#22B8CF", "#3B82F6", "#6366F1", "#EC4899", "#D946EF",
  ];
  const DEFAULT_PROFILE_COLOR = PROFILE_COLOR_PALETTE[0];
  const SAVE_WORK_NOTICE = "작업을 보관하려면 작품을 저장하세요.";

  const initialToken = new URL(location.href).searchParams.get("vanta") || "";

  const state = {
    token: initialToken,
    participantId: getParticipantId(),
    connectionId: randomToken(12),
    syncVersion: 2,
    revision: 0,
    lastProjectHash: "",
    projectBundle: null,
    editSequence: 0,
    syncedEditSequence: 0,
    lastEditAt: 0,
    unsyncedSinceAt: 0,
    editPointerActive: false,
    codeBoardViewportGesture: false,
    blockDragCandidate: null,
    localBlockDrag: null,
    applyingRemote: false,
    connected: false,
    stopped: false,
    syncTimer: 0,
    commandSyncTimer: 0,
    routeTimer: 0,
    heartbeatTimer: 0,
    remotePollTimer: 0,
    streamReconnectTimer: 0,
    streamReconnectBackoffMs: 1000,
    lastFullRecoveryAt: 0,
    liveLeaseAcquired: false,
    participantCount: 1,
    maxParticipants: 5,
    participants: [],
    chatMessages: [],
    chatOpen: false,
    chatMinimized: false,
    chatUnread: false,
    chatSendInFlight: false,
    chatCloseTimer: 0,
    chatPosition: null,
    chatDragging: false,
    lastChatSignature: "",
    profileDockOpen: false,
    cursorPoint: { area: "viewport", x: 0.5, y: 0.5, visible: false },
    cursorDirty: false,
    cursorInFlight: false,
    cursorTimer: 0,
    cursorContextTimer: 0,
    cursorLastRequestAt: 0,
    cursorLastWriteAt: 0,
    cursorSequence: 0,
    cursorAnimationFrame: 0,
    cursorContextInFlight: false,
    cursorContext: { sceneKey: "", objectKey: "" },
    cursorZonesVisible: false,
    cursorZoneTimer: 0,
    remoteCursors: new Map(),
    displayName: "",
    displayNameReadAt: 0,
    anonymousMode: false,
    liveCursorMode: false,
    liveCursorDesired: false,
    liveCursorTransition: null,
    liveCursorRetryTimer: 0,
    userColor: DEFAULT_PROFILE_COLOR,
    syncInFlight: false,
    syncGeneration: 0,
    pendingProjectChanges: [],
    pendingProjectChangeBytes: 0,
    projectChangeQueueRunning: false,
    projectChangeDrainTimer: 0,
    pendingRecoveryRevision: 0,
    pendingRecoverySession: null,
    connectionEpoch: 0,
    remoteApplyGeneration: 0,
    remoteApplyReleaseTimer: 0,
    streamPort: null,
    remotePollInFlight: false,
    remotePollGeneration: 0,
    pendingRemoteRevision: 0,
    remotePollRetryTimer: 0,
    remotePollBackoffMs: 700,
    panelCollapsed: false,
    panelVisible: Boolean(initialToken),
    panelVisibilityTimer: 0,
    headerLauncherTimer: 0,
    quotaOpen: false,
    quotaLoading: false,
    quota: null,
    quotaError: "",
    quotaRequestSequence: 0,
    quotaResetInFlight: false,
    quotaResetComplete: false,
    quotaResetFeedbackTimer: 0,
    settingsOpen: false,
    settingsCloseTimer: 0,
    tutorialPending: false,
    tutorialStep: 0,
    panelWidthFrame: 0,
    panelTargetWidth: 0,
    panelResizeObserver: null,
    panelMutationObserver: null,
    settingsLink: "",
    settingsLinkLoading: false,
    settingsLinkError: "",
    roomSettingsLoading: false,
    roomSettingsSaving: false,
    roomOwner: false,
    requestSequence: 0,
    pendingRequests: new Map(),
  };
  const copyFeedbackTimers = new WeakMap();

  function isCurrentConnection(epoch, token) {
    return state.connected && !state.stopped && state.connectionEpoch === epoch && state.token === token;
  }

  function randomToken(byteLength = 24) {
    const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
    let binary = "";
    for (const value of bytes) binary += String.fromCharCode(value);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function loadUiSettings() {
    try {
      const stored = await chrome.storage.local.get([UI_SETTINGS_KEY, TUTORIAL_COMPLETED_KEY]);
      const settings = stored?.[UI_SETTINGS_KEY];
      state.tutorialPending = (!settings || typeof settings !== "object")
        && stored?.[TUTORIAL_COMPLETED_KEY] !== true;
      if (settings && typeof settings === "object") {
        state.maxParticipants = Math.max(2, Math.min(5, Number(settings.maxParticipants || 5)));
        state.anonymousMode = settings.anonymousMode === true;
        if (/^#[0-9A-Fa-f]{6}$/.test(String(settings.userColor || ""))) {
          state.userColor = normalizeProfileColor(settings.userColor);
        } else {
          state.userColor = randomPaletteColor();
          await saveUiSettings();
        }
      } else {
        state.userColor = randomPaletteColor();
        await saveUiSettings();
      }
    } catch (_) {
      state.userColor = randomPaletteColor();
      state.tutorialPending = false;
    }
  }

  function randomPaletteColor() {
    const value = crypto.getRandomValues(new Uint32Array(1))[0];
    return PROFILE_COLOR_PALETTE[value % PROFILE_COLOR_PALETTE.length];
  }

  function saveUiSettings() {
    return chrome.storage.local.set({
      [UI_SETTINGS_KEY]: {
        maxParticipants: state.maxParticipants,
        anonymousMode: state.anonymousMode,
        userColor: state.userColor,
      },
    }).catch(() => {});
  }

  function getParticipantId() {
    const key = "vanta.participantId";
    let value = sessionStorage.getItem(key);
    if (!value) {
      value = randomToken(9);
      sessionStorage.setItem(key, value);
    }
    return value;
  }

  function getDisplayName() {
    if (state.anonymousMode) return "익명";
    const now = Date.now();
    if (state.displayName && now - state.displayNameReadAt < 2000) return state.displayName;
    let nickname = "";
    try {
      const raw = document.getElementById("__NEXT_DATA__")?.textContent || "";
      const page = raw ? JSON.parse(raw) : null;
      const common = page?.props?.pageProps?.initialState?.common;
      if (common && Object.prototype.hasOwnProperty.call(common, "user")) {
        nickname = common.user && typeof common.user.nickname === "string"
          ? common.user.nickname
          : "익명";
      }
    } catch (_) {}
    nickname = nickname
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 20);
    state.displayNameReadAt = now;
    if (nickname) state.displayName = nickname === "기본형" ? "익명" : nickname;
    return state.displayName;
  }

  async function waitForDisplayName(timeoutMs = 15000) {
    if (state.anonymousMode) return "익명";
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const name = getDisplayName();
      if (name) return name;
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }
    throw new Error("엔트리 닉네임을 찾을 수 없습니다.");
  }

  function isVantaWorkspace() {
    return location.pathname === "/ws/new" && Boolean(state.token);
  }

  function injectRuntime() {
    if (document.getElementById("vanta-page-runtime")) return;
    const script = document.createElement("script");
    script.id = "vanta-page-runtime";
    script.src = chrome.runtime.getURL("src/page-runtime.js");
    script.async = false;
    script.addEventListener("load", () => script.remove(), { once: true });
    script.addEventListener("error", () => script.remove(), { once: true });
    (document.head || document.documentElement).appendChild(script);
  }

  function pageRequest(type, payload, timeoutMs = 10000) {
    const requestId = `${state.participantId}:${Date.now()}:${++state.requestSequence}`;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        state.pendingRequests.delete(requestId);
        reject(new Error("엔트리 편집기의 응답 시간이 초과되었습니다."));
      }, timeoutMs);
      state.pendingRequests.set(requestId, { resolve, reject, timeout });
      window.postMessage({ source: CONTENT_SOURCE, type, payload, requestId }, location.origin);
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data || {};
    if (message.source !== PAGE_SOURCE) return;
    if (message.type === "VANTA_ENTRY_CHANGED" && !message.requestId) {
      markEntryCommandChange();
      return;
    }
    if (!message.requestId) return;
    const pending = state.pendingRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    state.pendingRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "엔트리 편집기 처리에 실패했습니다."));
  });

  async function waitForEntry(timeoutMs = 25000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const status = await pageRequest("VANTA_RUNTIME_STATUS", null, 1500);
        if (status?.ready) return status;
      } catch (_) {}
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    throw new Error("엔트리 편집기가 준비되지 않았습니다. 페이지를 새로고침해 주세요.");
  }

  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== "object") return value;
    const sorted = Object.create(null);
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
    return sorted;
  }

  async function sha256(value) {
    const data = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function captureStableProject(timeoutMs = 6000) {
    const startedAt = Date.now();
    let previousHash = "";
    let stableSamples = 0;
    let latestProject = null;
    let latestHash = "";

    while (Date.now() - startedAt < timeoutMs) {
      const candidate = await pageRequest("VANTA_EXPORT_PROJECT", null, 7000);
      if (candidate?.__vantaDeferred) {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        continue;
      }
      latestProject = candidate;
      latestHash = await sha256(latestProject);
      if (latestHash === previousHash) stableSamples += 1;
      else stableSamples = 0;
      if (stableSamples >= 2) return { project: latestProject, hash: latestHash };
      previousHash = latestHash;
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
    if (!latestProject) throw new Error("엔트리 작품 상태를 안정화하지 못했습니다.");
    return { project: latestProject, hash: latestHash };
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "VANTA 백그라운드 처리에 실패했습니다."));
          return;
        }
        resolve(response.result);
      });
    });
  }

  function getRoot() {
    return document.getElementById("vanta-root");
  }

  function updateHeaderLauncherState() {
    const button = document.querySelector("[data-vanta-header-launcher-button]");
    if (!button) return;
    const open = state.panelVisible;
    button.dataset.active = open ? "1" : "0";
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "VANTA 패널 닫기" : "VANTA 패널 열기");
    button.title = open ? "VANTA 닫기" : "VANTA 열기";
  }

  function setPanelVisible(open, options = {}) {
    const root = getRoot();
    if (!root) return;
    const next = open === true;
    if (state.panelVisible === next && root.dataset.launcherOpen === (next ? "1" : "0")) return;
    window.clearTimeout(state.panelVisibilityTimer);
    state.panelVisibilityTimer = 0;
    state.panelVisible = next;
    root.dataset.launcherMotion = "1";
    if (!next) {
      window.clearTimeout(state.settingsCloseTimer);
      state.settingsCloseTimer = 0;
      state.settingsOpen = false;
      state.profileDockOpen = false;
      state.quotaOpen = false;
      delete root.dataset.settingsClosing;
      root.dataset.settingsOpen = "0";
      updateQuotaDisplay(root);
      updateSettingsDisplay(root);
    }
    root.dataset.launcherOpen = next ? "1" : "0";
    updateHeaderLauncherState();
    if (options.immediate === true) {
      state.panelTargetWidth = next ? 0 : -1;
      updatePanelContentWidth(root);
      delete root.dataset.launcherMotion;
      return;
    }
    window.requestAnimationFrame(() => updatePanelContentWidth(root));
    state.panelVisibilityTimer = window.setTimeout(() => {
      delete root.dataset.launcherMotion;
      state.panelVisibilityTimer = 0;
    }, 460);
  }

  function ensureHeaderLauncher() {
    const current = document.querySelector("[data-vanta-header-launcher]");
    const helpButton = document.getElementById("header_help");
    const referenceWrapper = helpButton?.parentElement;
    const actionBar = referenceWrapper?.parentElement;
    if (!actionBar || !referenceWrapper) return;
    if (current?.parentElement === actionBar) {
      updateHeaderLauncherState();
      return;
    }
    current?.remove();
    const wrapper = document.createElement(referenceWrapper.tagName.toLowerCase());
    wrapper.className = `${referenceWrapper.className} vanta-entry-launcher`.trim();
    wrapper.dataset.vantaHeaderLauncher = "1";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vanta-entry-launcher-button";
    button.dataset.vantaHeaderLauncherButton = "1";
    const icon = document.createElement("span");
    icon.className = "vanta-entry-launcher-icon";
    const image = document.createElement("img");
    image.src = chrome.runtime.getURL("assets/V_2.svg");
    image.alt = "";
    image.draggable = false;
    icon.append(image);
    button.append(icon);
    button.addEventListener("click", () => setPanelVisible(!state.panelVisible));
    wrapper.append(button);
    actionBar.insertBefore(wrapper, actionBar.firstElementChild);
    updateHeaderLauncherState();
  }

  function watchHeaderLauncher() {
    window.clearInterval(state.headerLauncherTimer);
    ensureHeaderLauncher();
    state.headerLauncherTimer = window.setInterval(ensureHeaderLauncher, 750);
  }

  function isVantaUiTarget(target) {
    return Boolean(getRoot()?.contains(target)
      || document.getElementById("vanta-chat")?.contains(target)
      || document.querySelector("[data-vanta-header-launcher]")?.contains(target));
  }

  const CURSOR_AREA_SELECTORS = {
    stage: [".entryEngineWorkspace_w", ".entryCanvasWorkspace"],
    enginebar: [".entryEngineButtonWrapper"],
    scenes: [".ne-header", ".entrySceneWorkspace", ".entrySceneListWorkspace"],
    objects: [".propertyPanel", ".entryContainerListWorkspaceWrapper", ".entryContainerWorkspace"],
    properties: [".entryVariablePanelWorkspace", "[class*='entryProperty']"],
    tabs: [".entryTabListWorkspace", ".entryPlaygroundTabWorkspace"],
    blockmenu: [".entryWorkspaceBlockMenu", ".blockMenuWrapper"],
    codeboard: [".entryWorkspaceBoard", ".entryBoardWrapper"],
    playground: [".entryPlaygroundWorkspace", ".entryPlayground"],
  };

  const CURSOR_AREA_FALLBACKS = {
    codeboard: "playground",
    blockmenu: "playground",
    tabs: "playground",
    properties: "objects",
  };

  const CURSOR_AREA_ORDER = [
    "scenes",
    "tabs",
    "blockmenu",
    "codeboard",
    "enginebar",
    "stage",
    "properties",
    "objects",
    "playground",
  ];

  const CURSOR_ZONE_DEFINITIONS = [
    { area: "scenes", label: "헤더", displayArea: "header", color: "#4D96FF" },
    { area: "stage", label: "실행 화면", color: "#4D96FF" },
    { area: "enginebar", label: "오브젝트 추가 · 시작", color: "#FF9F43" },
    { area: "objects", label: "오브젝트", color: "#2ED573" },
    { area: "properties", label: "속성", color: "#FF6B81" },
    { area: "tabs", label: "편집 탭", color: "#A55EEA" },
    { area: "blockmenu", label: "블록 목록", color: "#FFD93D" },
    { area: "codeboard", label: "코드 보드", color: "#00D2D3" },
  ];

  function visibleRect(element) {
    if (!(element instanceof Element)) return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 8 && rect.height > 8 ? rect : null;
  }

  function cursorAreaRect(area) {
    if (area === "viewport") return { left: 0, top: 0, width: innerWidth, height: innerHeight };
    for (const selector of CURSOR_AREA_SELECTORS[area] || []) {
      for (const element of document.querySelectorAll(selector)) {
        const rect = visibleRect(element);
        if (rect) return rect;
      }
    }
    const fallback = CURSOR_AREA_FALLBACKS[area];
    if (fallback) return cursorAreaRect(fallback);
    return { left: 0, top: 0, width: innerWidth, height: innerHeight };
  }

  function cursorAreaRects(area) {
    for (const selector of CURSOR_AREA_SELECTORS[area] || []) {
      const result = [];
      const seen = new Set();
      for (const element of document.querySelectorAll(selector)) {
        const rect = visibleRect(element);
        if (!rect) continue;
        const key = `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(rect);
      }
      if (result.length) return result;
    }
    return [];
  }

  function rectContainsPoint(rect, clientX, clientY) {
    return clientX >= rect.left && clientX <= rect.right
      && clientY >= rect.top && clientY <= rect.bottom;
  }

  function updateCursorZoneOverlay() {
    const layer = document.getElementById("vanta-cursor-zones");
    if (!layer || !state.cursorZonesVisible) return;
    const boxesLayer = layer.querySelector("[data-vanta-cursor-zone-boxes]");
    if (!boxesLayer) return;
    const boxes = [];
    for (const definition of CURSOR_ZONE_DEFINITIONS) {
      for (const rect of cursorAreaRects(definition.area)) {
        const box = document.createElement("div");
        box.className = "vanta-cursor-zone";
        box.dataset.area = definition.area;
        box.style.setProperty("--vanta-zone-color", definition.color);
        box.style.left = `${rect.left}px`;
        box.style.top = `${rect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        const label = document.createElement("span");
        label.textContent = `${definition.label} · ${definition.displayArea || definition.area}`;
        box.append(label);
        boxes.push(box);
      }
    }
    boxesLayer.replaceChildren(...boxes);
  }

  function updateCursorZoneProbe(event) {
    if (!state.cursorZonesVisible) return;
    const probe = document.querySelector("#vanta-cursor-zones [data-vanta-codeboard-probe]");
    const probeText = probe?.querySelector("span");
    const rect = cursorAreaRects("codeboard")[0];
    if (!probe || !probeText || !rect || !rectContainsPoint(rect, event.clientX, event.clientY)) {
      if (probe) probe.hidden = true;
      return;
    }
    const ratioX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const ratioY = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const svg = [...document.querySelectorAll(".entryBoardWrapper .entryBoard")]
      .find((element) => visibleRect(element));
    const block = svg ? codeBoardBlockAt(svg, "", event.clientX, event.clientY) : null;
    let detail = `보드 X ${(ratioX * 100).toFixed(1)}% · Y ${(ratioY * 100).toFixed(1)}%`;
    const blockRect = visibleRect(block);
    if (block && blockRect) {
      const localX = Math.max(0, Math.min(1, (event.clientX - blockRect.left) / blockRect.width));
      const localY = Math.max(0, Math.min(1, (event.clientY - blockRect.top) / blockRect.height));
      detail = `블록 ${codeBoardBlockIdentity(block)} · X ${(localX * 100).toFixed(1)}% · Y ${(localY * 100).toFixed(1)}%`;
    }
    probe.hidden = false;
    probe.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0)`;
    probeText.textContent = detail;
  }

  function renderCursorZoneOverlay() {
    window.clearInterval(state.cursorZoneTimer);
    state.cursorZoneTimer = 0;
    document.getElementById("vanta-cursor-zones")?.remove();
    if (!state.cursorZonesVisible || !document.body) return;
    const layer = document.createElement("div");
    layer.id = "vanta-cursor-zones";
    layer.setAttribute("aria-hidden", "true");
    const boxes = document.createElement("div");
    boxes.dataset.vantaCursorZoneBoxes = "1";
    const probe = document.createElement("div");
    probe.className = "vanta-codeboard-probe";
    probe.dataset.vantaCodeboardProbe = "1";
    probe.hidden = true;
    probe.append(document.createElement("span"));
    layer.append(boxes, probe);
    document.body.append(layer);
    updateCursorZoneOverlay();
    state.cursorZoneTimer = window.setInterval(updateCursorZoneOverlay, 250);
  }

  function setCursorZonesVisible(visible) {
    state.cursorZonesVisible = Boolean(visible);
    saveUiSettings();
    renderCursorZoneOverlay();
    updateSettingsDisplay();
  }

  function codeBoardBlockIdentity(block) {
    if (!(block instanceof Element)) return "";
    const path = block.querySelector(":scope > g > .blockPath[blockId], .blockPath[blockId]");
    return String(path?.getAttribute("blockId") || "").trim().slice(0, 32);
  }

  const CODE_BOARD_ANCHOR_RANGE = 128;

  function codeBoardBlockKey(block, anchor = false) {
    const text = codeBoardBlockIdentity(block);
    if (!text) return "";
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const base = (hash >>> 0) & 0x7fffffff;
    const marked = anchor ? (base | 0x80000000) >>> 0 : base;
    return marked.toString(16).padStart(8, "0");
  }

  function codeBoardAnchorKey(blockKey) {
    return /^[89a-f][a-f0-9]{7}$/.test(String(blockKey || ""));
  }

  function codeBoardBlockAt(svg, blockKey, clientX, clientY) {
    if (blockKey) {
      const anchor = codeBoardAnchorKey(blockKey);
      return [...svg.querySelectorAll(".block[id]")]
        .find((element) => codeBoardBlockKey(element, anchor) === blockKey && visibleRect(element)) || null;
    }
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const hit = document.elementFromPoint(clientX, clientY);
    const block = hit instanceof Element ? hit.closest(".block[id]") : null;
    return block instanceof Element && svg.contains(block) ? block : null;
  }

  function codeBoardNearestBlock(svg, clientX, clientY) {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    let nearest = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const block of svg.querySelectorAll(".block[id]")) {
      if (!codeBoardBlockIdentity(block)) continue;
      const rect = visibleRect(block);
      if (!rect) continue;
      const dx = clientX < rect.left
        ? rect.left - clientX
        : clientX > rect.right ? clientX - rect.right : 0;
      const dy = clientY < rect.top
        ? rect.top - clientY
        : clientY > rect.bottom ? clientY - rect.bottom : 0;
      const distance = (dx * dx) + (dy * dy);
      if (distance < nearestDistance) {
        nearest = block;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  function encodeCodeBoardAnchorOffset(value) {
    return Math.max(0, Math.min(1,
      (Number(value) + CODE_BOARD_ANCHOR_RANGE) / (CODE_BOARD_ANCHOR_RANGE * 2)
    ));
  }

  function decodeCodeBoardAnchorOffset(value) {
    return (Math.max(0, Math.min(1, Number(value) || 0)) * CODE_BOARD_ANCHOR_RANGE * 2)
      - CODE_BOARD_ANCHOR_RANGE;
  }

  function codeBoardCoordinateSpace(blockKey = "", clientX = null, clientY = null) {
    const svg = [...document.querySelectorAll(".entryBoardWrapper .entryBoard")]
      .find((element) => visibleRect(element));
    if (!visibleRect(svg)) return null;
    const requestedBlockKey = /^[a-f0-9]{8}$/.test(String(blockKey || ""))
      ? String(blockKey)
      : "";
    let anchorBlock = codeBoardBlockAt(svg, requestedBlockKey, clientX, clientY);
    if (requestedBlockKey && !anchorBlock) return null;
    let anchor = codeBoardAnchorKey(requestedBlockKey);
    if (!requestedBlockKey && !anchorBlock) {
      anchorBlock = codeBoardNearestBlock(svg, clientX, clientY);
      anchor = Boolean(anchorBlock);
    }
    if (!anchorBlock) return null;
    const rect = visibleRect(anchorBlock);
    if (!rect) return null;
    return {
      svg,
      rect,
      anchor,
      blockKey: codeBoardBlockKey(anchorBlock, anchor),
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

  function cursorCoordinateFromScreen(
    area,
    clientX,
    clientY,
    blockKey = "",
    clampResult = true,
    allowCodeBoardReanchor = true
  ) {
    const rect = cursorAreaRect(area);
    const fallbackX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const fallbackY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const wantsCodeBoardBlock = area === "codeboard" && Boolean(blockKey);
    let codeBoard = area === "codeboard" && (wantsCodeBoardBlock || allowCodeBoardReanchor)
      ? codeBoardCoordinateSpace(blockKey, clientX, clientY)
      : null;
    if (wantsCodeBoardBlock && !codeBoard && allowCodeBoardReanchor) {
      codeBoard = codeBoardCoordinateSpace("", clientX, clientY);
    }
    if (wantsCodeBoardBlock && !codeBoard && !allowCodeBoardReanchor) return null;
    if (codeBoard) {
      const rawX = (clientX - codeBoard.rect.left) / codeBoard.rect.width;
      const rawY = (clientY - codeBoard.rect.top) / codeBoard.rect.height;
      const x = codeBoard.anchor ? encodeCodeBoardAnchorOffset(rawX) : rawX;
      const y = codeBoard.anchor ? encodeCodeBoardAnchorOffset(rawY) : rawY;
      return {
        blockKey: codeBoard.blockKey,
        x: clampResult ? Math.max(0, Math.min(1, x)) : x,
        y: clampResult ? Math.max(0, Math.min(1, y)) : y,
        fallbackX,
        fallbackY,
      };
    }
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return {
      blockKey: "",
      x: clampResult ? Math.max(0, Math.min(1, x)) : x,
      y: clampResult ? Math.max(0, Math.min(1, y)) : y,
    };
  }

  async function refreshCursorContext() {
    if (!state.connected || state.stopped || state.cursorContextInFlight) return;
    state.cursorContextInFlight = true;
    const epoch = state.connectionEpoch;
    try {
      const status = await pageRequest("VANTA_RUNTIME_STATUS", null, 1500);
      if (epoch !== state.connectionEpoch || !state.connected) return;
      const next = {
        sceneKey: cursorContextKey(status?.sceneId),
        objectKey: cursorContextKey(status?.objectId),
      };
      if (next.sceneKey !== state.cursorContext.sceneKey
        || next.objectKey !== state.cursorContext.objectKey) {
        state.cursorContext = next;
        state.cursorDirty = true;
      }
    } catch (_) {
      // Context only controls remote cursor emphasis.
    } finally {
      state.cursorContextInFlight = false;
    }
  }

  function cursorAreaAt(clientX, clientY) {
    for (const area of CURSOR_AREA_ORDER) {
      const rect = cursorAreaRects(area).find((candidate) => rectContainsPoint(candidate, clientX, clientY));
      if (rect) return { area, rect };
    }
    return { area: "viewport", rect: cursorAreaRect("viewport") };
  }

  function trackLocalCursor(event) {
    if (!state.connected || state.stopped) return;
    if (isVantaUiTarget(event.target)) {
      hideLocalCursor();
      return;
    }
    const { area } = cursorAreaAt(event.clientX, event.clientY);
    const previous = state.cursorPoint;
    const point = cursorCoordinateFromScreen(
      area,
      event.clientX,
      event.clientY,
      ""
    );
    if (!point) return;
    const nextPoint = {
      area,
      ...point,
      visible: true,
    };
    if (previous.visible === nextPoint.visible
      && previous.area === nextPoint.area
      && previous.blockKey === nextPoint.blockKey
      && previous.x === nextPoint.x
      && previous.y === nextPoint.y) return;
    state.cursorPoint = nextPoint;
    state.cursorDirty = true;
  }

  function hideLocalCursor() {
    if (!state.cursorPoint.visible) return;
    state.cursorPoint = { ...state.cursorPoint, visible: false };
    state.cursorDirty = true;
  }

  function cursorElement(cursor) {
    const element = document.createElement("div");
    element.className = "vanta-remote-cursor";
    element.dataset.participantId = cursor.participantId;
    element.style.setProperty("--vanta-cursor-color", normalizeProfileColor(cursor.color));
    element.style.setProperty("--vanta-cursor-foreground", contrastTextColor(cursor.color));
    const pointer = document.createElement("span");
    pointer.className = "vanta-remote-cursor-pointer";
    const label = document.createElement("span");
    label.className = "vanta-remote-cursor-label";
    label.textContent = String(cursor.name || "참여자").slice(0, 20);
    element.append(pointer, label);
    (document.body || document.documentElement).appendChild(element);
    return element;
  }

  function clearRemoteBlockDrag(cursor) {
    cursor?.blockDragElement?.remove();
    if (cursor) {
      cursor.blockDragElement = null;
      cursor.blockDragKey = "";
    }
  }

  function createRemoteBlockDrag(cursor) {
    const svg = [...document.querySelectorAll(".entryBoardWrapper .entryBoard")]
      .find((element) => visibleRect(element));
    if (!svg || !/^[a-f0-9]{8}$/.test(String(cursor.dragBlockKey || ""))) return null;
    const block = codeBoardBlockAt(svg, cursor.dragBlockKey, null, null);
    if (!(block instanceof SVGGraphicsElement)) return null;
    let box;
    try {
      box = block.getBBox();
    } catch (_) {
      return null;
    }
    const rect = visibleRect(block);
    if (!rect || !box || box.width <= 0 || box.height <= 0) return null;

    const element = document.createElement("div");
    element.className = "vanta-remote-block-drag";
    element.style.setProperty("--vanta-cursor-color", cursor.color);
    element.dataset.blockKey = cursor.dragBlockKey;
    const preview = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    preview.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
    preview.setAttribute("width", String(rect.width));
    preview.setAttribute("height", String(rect.height));
    const clone = block.cloneNode(true);
    clone.removeAttribute("transform");
    clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    preview.appendChild(clone);
    element.appendChild(preview);
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
    (document.body || document.documentElement).appendChild(element);
    cursor.blockDragElement = element;
    cursor.blockDragKey = cursor.dragBlockKey;
    return element;
  }

  function updateRemoteBlockDrag(cursor, otherContext) {
    if (!cursor.dragging || cursor.area !== "codeboard" || otherContext
      || !/^[a-f0-9]{8}$/.test(String(cursor.dragBlockKey || ""))) {
      clearRemoteBlockDrag(cursor);
      return;
    }
    if (cursor.blockDragKey !== cursor.dragBlockKey) clearRemoteBlockDrag(cursor);
    const element = cursor.blockDragElement || createRemoteBlockDrag(cursor);
    if (!element || cursor.currentX === null || cursor.currentY === null) return;
    const width = element.getBoundingClientRect().width || parseFloat(element.style.width) || 0;
    const height = element.getBoundingClientRect().height || parseFloat(element.style.height) || 0;
    const left = cursor.currentX - width * cursor.dragOffsetX;
    const top = cursor.currentY - height * cursor.dragOffsetY;
    element.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  }

  function receiveRemoteCursors(cursors) {
    const now = Date.now();
    for (const cursor of Array.isArray(cursors) ? cursors : []) {
      if (!cursor?.participantId || cursor.participantId === state.participantId) continue;
      if (cursor.visible === false) {
        const hidden = state.remoteCursors.get(cursor.participantId);
        hidden?.element?.remove();
        clearRemoteBlockDrag(hidden);
        state.remoteCursors.delete(cursor.participantId);
        continue;
      }
      const existing = state.remoteCursors.get(cursor.participantId) || {
        element: null,
        currentX: null,
        currentY: null,
        renderX: null,
        renderY: null,
      };
      const nextX = Math.max(0, Math.min(1, Number(cursor.x) || 0));
      const nextY = Math.max(0, Math.min(1, Number(cursor.y) || 0));
      const nextArea = String(cursor.area || "viewport");
      const nextBlockKey = String(cursor.blockKey || "").slice(0, 8);
      const nextFallbackX = cursor.fallbackX === undefined
        ? null
        : Math.max(0, Math.min(1, Number(cursor.fallbackX) || 0));
      const nextFallbackY = cursor.fallbackY === undefined
        ? null
        : Math.max(0, Math.min(1, Number(cursor.fallbackY) || 0));
      const serverAt = Number(cursor.at || 0);
      const nextConnectionId = String(cursor.connectionId || "").slice(0, 64);
      const nextSequence = Math.max(0, Number(cursor.seq || 0) | 0);
      const sameConnection = Boolean(existing.connectionId && nextConnectionId
        && existing.connectionId === nextConnectionId);
      const isNewSample = !existing.serverAt
        || serverAt > existing.serverAt
        || (serverAt === existing.serverAt && sameConnection && nextSequence > Number(existing.seq || 0));
      if (!isNewSample) continue;
      const coordinateSpaceChanged = Boolean(existing.area)
        && (existing.area !== nextArea || existing.blockKey !== nextBlockKey);
      const remappedCurrent = coordinateSpaceChanged && existing.currentX !== null
        ? cursorCoordinateFromScreen(
          nextArea,
          existing.currentX,
          existing.currentY,
          nextBlockKey,
          false,
          false
        )
        : null;
      existing.participantId = String(cursor.participantId);
      existing.name = String(cursor.name || "참여자").slice(0, 20);
      existing.color = normalizeProfileColor(cursor.color);
      existing.area = nextArea;
      existing.sceneKey = String(cursor.sceneKey || "").slice(0, 6);
      existing.objectKey = String(cursor.objectKey || "").slice(0, 6);
      existing.blockKey = nextBlockKey;
      existing.dragging = cursor.dragging === true;
      existing.dragBlockKey = /^[a-f0-9]{8}$/.test(String(cursor.dragBlockKey || ""))
        ? String(cursor.dragBlockKey)
        : "";
      existing.dragOffsetX = Math.max(0, Math.min(1, Number(cursor.dragOffsetX) || 0));
      existing.dragOffsetY = Math.max(0, Math.min(1, Number(cursor.dragOffsetY) || 0));
      if (!existing.dragging) clearRemoteBlockDrag(existing);
      existing.fallbackX = nextFallbackX;
      existing.fallbackY = nextFallbackY;
      existing.connectionId = nextConnectionId;
      existing.seq = nextSequence;
      if (isNewSample) {
        const sampleGap = existing.serverAt && serverAt
          ? Math.max(20, Math.min(140, serverAt - existing.serverAt))
          : 50;
        existing.renderX = coordinateSpaceChanged
          ? (remappedCurrent?.x ?? nextX)
          : (existing.renderX ?? existing.x ?? nextX);
        existing.renderY = coordinateSpaceChanged
          ? (remappedCurrent?.y ?? nextY)
          : (existing.renderY ?? existing.y ?? nextY);
        existing.motionFromX = existing.renderX;
        existing.motionFromY = existing.renderY;
        existing.motionStartedAt = now;
        existing.motionDuration = Math.max(100, Math.min(190, sampleGap * 1.45));
        existing.x = nextX;
        existing.y = nextY;
        existing.serverAt = serverAt;
      }
      existing.lastSeenAt = now;
      existing.element ||= cursorElement(existing);
      existing.element.style.setProperty("--vanta-cursor-color", existing.color);
      existing.element.style.setProperty("--vanta-cursor-foreground", contrastTextColor(existing.color));
      existing.element.querySelector(".vanta-remote-cursor-label").textContent = existing.name;
      state.remoteCursors.set(existing.participantId, existing);
    }
    if (!state.cursorAnimationFrame) state.cursorAnimationFrame = requestAnimationFrame(animateRemoteCursors);
  }

  function clearRemoteCursors() {
    if (state.cursorAnimationFrame) cancelAnimationFrame(state.cursorAnimationFrame);
    state.cursorAnimationFrame = 0;
    for (const cursor of state.remoteCursors.values()) {
      cursor.element?.remove();
      clearRemoteBlockDrag(cursor);
    }
    state.remoteCursors.clear();
  }

  function animateRemoteCursors() {
    state.cursorAnimationFrame = 0;
    const now = Date.now();
    let keepAnimating = false;
    for (const [participantId, cursor] of state.remoteCursors) {
      if (!state.connected || now - cursor.lastSeenAt > 3200) {
        cursor.element?.remove();
        clearRemoteBlockDrag(cursor);
        state.remoteCursors.delete(participantId);
        continue;
      }
      const rect = cursorAreaRect(cursor.area);
      const localContext = state.cursorContext;
      const otherContext = (
        (cursor.sceneKey && localContext.sceneKey && cursor.sceneKey !== localContext.sceneKey)
        || (cursor.objectKey && localContext.objectKey && cursor.objectKey !== localContext.objectKey)
      );
      const codeBoard = cursor.area === "codeboard" && cursor.blockKey && !otherContext
        ? codeBoardCoordinateSpace(cursor.blockKey)
        : null;
      if (cursor.area === "codeboard" && cursor.blockKey && !otherContext && !codeBoard) {
        // Entry briefly removes/recreates the SVG during board scrolling and
        // project refreshes. Keep the last screen position until its coordinate
        // space is available again instead of interpreting SVG values as ratios.
        cursor.element.hidden = cursor.currentX === null || cursor.currentY === null;
        keepAnimating = true;
        continue;
      }
      cursor.element.hidden = false;
      const motionProgress = Math.min(1, Math.max(0,
        (now - Number(cursor.motionStartedAt || now)) / Number(cursor.motionDuration || 1)
      ));
      cursor.renderX = Number(cursor.motionFromX ?? cursor.x)
        + (cursor.x - Number(cursor.motionFromX ?? cursor.x)) * motionProgress;
      cursor.renderY = Number(cursor.motionFromY ?? cursor.y)
        + (cursor.y - Number(cursor.motionFromY ?? cursor.y)) * motionProgress;
      const useCodeBoardFallback = cursor.area === "codeboard" && cursor.blockKey && otherContext;
      const targetRect = codeBoard?.rect || rect;
      const renderX = useCodeBoardFallback
        ? (cursor.fallbackX ?? cursor.x)
        : codeBoard?.anchor
          ? decodeCodeBoardAnchorOffset(cursor.renderX)
          : cursor.renderX;
      const renderY = useCodeBoardFallback
        ? (cursor.fallbackY ?? cursor.y)
        : codeBoard?.anchor
          ? decodeCodeBoardAnchorOffset(cursor.renderY)
          : cursor.renderY;
      const targetX = targetRect.left + targetRect.width * renderX;
      const targetY = targetRect.top + targetRect.height * renderY;
      const followRate = 0.3;
      cursor.currentX = cursor.currentX === null ? targetX : cursor.currentX + (targetX - cursor.currentX) * followRate;
      cursor.currentY = cursor.currentY === null ? targetY : cursor.currentY + (targetY - cursor.currentY) * followRate;
      cursor.element.style.transform = `translate3d(${cursor.currentX}px, ${cursor.currentY}px, 0)`;
      cursor.element.dataset.otherContext = otherContext ? "1" : "0";
      cursor.element.dataset.stale = now - cursor.lastSeenAt > 1800 ? "1" : "0";
      updateRemoteBlockDrag(cursor, otherContext);
      keepAnimating = true;
    }
    if (keepAnimating) state.cursorAnimationFrame = requestAnimationFrame(animateRemoteCursors);
  }

  async function flushCursor() {
    if (!state.connected || state.stopped || !state.liveCursorMode || state.cursorInFlight) return;
    const now = Date.now();
    const elapsed = now - state.cursorLastRequestAt;
    if (!state.cursorDirty && now - state.cursorLastWriteAt < CURSOR_KEEPALIVE_INTERVAL_MS) return;
    if (state.cursorDirty && elapsed < LIVE_CURSOR_INTERVAL_MS) return;
    const shouldWrite = state.cursorDirty || now - state.cursorLastWriteAt >= CURSOR_KEEPALIVE_INTERVAL_MS;
    state.cursorDirty = false;
    state.cursorInFlight = true;
    state.cursorLastRequestAt = now;
    if (shouldWrite) state.cursorLastWriteAt = now;
    state.cursorSequence = (state.cursorSequence + 1) & 0x7fffffff;
    const epoch = state.connectionEpoch;
    const point = state.cursorPoint;
    try {
      const cursorResult = await sendRuntimeMessage({
        type: "VANTA_UPDATE_CURSOR",
        token: state.token,
        participantId: state.participantId,
        connectionId: state.connectionId,
        seq: state.cursorSequence,
        liveCursorMode: state.liveCursorMode,
        name: getDisplayName(),
        color: profileColor(),
        ...state.cursorContext,
        ...point,
        dragging: Boolean(state.localBlockDrag),
        dragBlockKey: state.localBlockDrag?.blockKey || "",
        dragOffsetX: state.localBlockDrag?.offsetX || 0,
        dragOffsetY: state.localBlockDrag?.offsetY || 0,
      });
      if (epoch === state.connectionEpoch && state.connected) {
        const cursors = Array.isArray(cursorResult) ? cursorResult : cursorResult?.cursors;
        receiveRemoteCursors(cursors);
        if (cursorResult?.quota) {
          state.quota = cursorResult.quota;
          state.quotaError = "";
          updateQuotaDisplay();
        }
      }
    } catch (error) {
      if (shouldWrite) state.cursorDirty = true;
      disableLiveCursorAfterFailure(error);
      // Cursor presence is optional and must never interrupt project synchronization.
    } finally {
      state.cursorInFlight = false;
    }
  }

  function markUserEdit(event) {
    if (!state.connected || event.isTrusted === false || isVantaUiTarget(event.target)) return;
    const now = Date.now();
    if (!state.unsyncedSinceAt) state.unsyncedSinceAt = now;
    state.lastEditAt = now;
    state.editSequence += 1;
  }

  function isCodeBoardViewportTarget(target) {
    if (!(target instanceof Element) || !target.closest(".entryBoardWrapper")) return false;
    return !target.closest(".block[id]");
  }

  function scheduleCommandSync() {
    window.clearTimeout(state.commandSyncTimer);
    state.commandSyncTimer = window.setTimeout(() => {
      state.commandSyncTimer = 0;
      exportAndStoreIfChanged(true);
    }, COMMAND_SYNC_DEBOUNCE_MS);
  }

  function markEntryCommandChange() {
    if (!state.connected || state.applyingRemote || state.stopped) return;
    const now = Date.now();
    if (!state.unsyncedSinceAt) state.unsyncedSinceAt = now;
    state.lastEditAt = now;
    state.editSequence += 1;
    scheduleCommandSync();
  }

  function beginPointerEdit(event) {
    if (isVantaUiTarget(event.target)) return;
    state.codeBoardViewportGesture = isCodeBoardViewportTarget(event.target);
    state.blockDragCandidate = null;
    state.localBlockDrag = null;
    if (state.codeBoardViewportGesture) return;
    const block = event.target instanceof Element ? event.target.closest(".block[id]") : null;
    const blockRect = block instanceof Element && block.closest(".entryBoardWrapper")
      ? visibleRect(block)
      : null;
    const blockKey = blockRect ? codeBoardBlockKey(block) : "";
    if (blockRect && blockKey) {
      state.blockDragCandidate = {
        blockKey,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: Math.max(0, Math.min(1, (event.clientX - blockRect.left) / blockRect.width)),
        offsetY: Math.max(0, Math.min(1, (event.clientY - blockRect.top) / blockRect.height)),
      };
    }
    state.editPointerActive = true;
    markUserEdit(event);
  }

  function continuePointerEdit(event) {
    if (state.codeBoardViewportGesture) return;
    if (!state.editPointerActive) return;
    if (!state.localBlockDrag && state.blockDragCandidate) {
      const dx = event.clientX - state.blockDragCandidate.startX;
      const dy = event.clientY - state.blockDragCandidate.startY;
      if ((dx * dx) + (dy * dy) >= 16) {
        state.localBlockDrag = {
          blockKey: state.blockDragCandidate.blockKey,
          offsetX: state.blockDragCandidate.offsetX,
          offsetY: state.blockDragCandidate.offsetY,
        };
        state.cursorDirty = true;
      }
    }
    markUserEdit(event);
  }

  function endPointerEdit(event) {
    const wasDraggingBlock = Boolean(state.localBlockDrag);
    state.blockDragCandidate = null;
    state.localBlockDrag = null;
    if (wasDraggingBlock) state.cursorDirty = true;
    if (state.codeBoardViewportGesture) {
      state.codeBoardViewportGesture = false;
      return;
    }
    if (!state.editPointerActive) return;
    markUserEdit(event);
    state.editPointerActive = false;
    scheduleCommandSync();
  }

  function setStatus(text, kind = "") {
    const root = getRoot();
    if (!root) return;
    const status = root.querySelector("[data-vanta-status]");
    const statusWrap = root.querySelector("[data-vanta-status-wrap]");
    const statusIcon = root.querySelector("[data-vanta-status-icon]");
    const message = String(text || "").trim();
    if (status) status.textContent = message;
    if (statusWrap) statusWrap.hidden = !message;
    if (statusIcon && message) {
      const iconName = kind === "error" ? "error" : kind === "warning" ? "warning" : kind === "working" ? "sync" : "check";
      setElementIcon(statusIcon, iconName);
    }
    root.dataset.kind = kind;
    updatePanelContentWidth(root);
  }

  function stylePixels(style, property) {
    return Number.parseFloat(style?.[property]) || 0;
  }

  function visibleChildren(element) {
    return element
      ? [...element.children].filter((child) => !child.hidden && getComputedStyle(child).display !== "none")
      : [];
  }

  function naturalFlexWidth(element, depth = 0) {
    if (!element) return 0;
    const children = visibleChildren(element);
    const gap = stylePixels(getComputedStyle(element), "columnGap");
    return children.reduce((total, child) => {
      const childStyle = getComputedStyle(child);
      const rectWidth = Number(child.getBoundingClientRect().width) || 0;
      const offsetWidth = Number(child.offsetWidth) || 0;
      const scrollWidth = Number(child.scrollWidth) || 0;
      const directChildrenWidth = depth < 3 ? naturalFlexWidth(child, depth + 1) : 0;
      const width = Math.max(
        rectWidth,
        offsetWidth,
        offsetWidth > 0 ? 0 : scrollWidth,
        directChildrenWidth + stylePixels(childStyle, "paddingLeft") + stylePixels(childStyle, "paddingRight")
          + stylePixels(childStyle, "borderLeftWidth") + stylePixels(childStyle, "borderRightWidth"),
      );
      const autoAlignedActions = child.classList?.contains("vanta-actions") === true;
      const margins = autoAlignedActions
        ? 0
        : stylePixels(childStyle, "marginLeft") + stylePixels(childStyle, "marginRight");
      return total + width + margins;
    }, 0)
      + Math.max(0, children.length - 1) * gap;
  }

  function naturalPanelWidth(root, content, contentWidth) {
    if (root.dataset.launcherOpen === "0") return 0;
    const rootStyle = getComputedStyle(root);
    const topRow = root.querySelector(".vanta-top-row");
    const topStyle = topRow ? getComputedStyle(topRow) : null;
    const brand = root.querySelector(".vanta-brand");
    const contentStyle = getComputedStyle(content);
    const openHorizontalPadding = Number.parseFloat(rootStyle.getPropertyValue("--vanta-panel-horizontal-padding")) || 0;
    const openBorderWidth = Number.parseFloat(rootStyle.getPropertyValue("--vanta-panel-border-width")) || 0;
    const rootChrome = root.dataset.launcherOpen === "1"
      ? (openHorizontalPadding + openBorderWidth) * 2
      : stylePixels(rootStyle, "paddingLeft") + stylePixels(rootStyle, "paddingRight")
        + stylePixels(rootStyle, "borderLeftWidth") + stylePixels(rootStyle, "borderRightWidth");
    const topChrome = stylePixels(topStyle, "paddingLeft") + stylePixels(topStyle, "paddingRight")
      + stylePixels(topStyle, "borderLeftWidth") + stylePixels(topStyle, "borderRightWidth");
    const openContentMargin = Number.parseFloat(contentStyle.getPropertyValue("--vanta-panel-content-open-margin")) || 0;
    const contentMargins = openContentMargin + stylePixels(contentStyle, "marginRight");
    const brandWidth = Math.max(brand?.getBoundingClientRect().width || 0, brand?.offsetWidth || 0, brand?.scrollWidth || 0);
    const expandedContentWidth = root.dataset.collapsed === "1" ? 0 : contentMargins + contentWidth;
    let target = rootChrome + topChrome + brandWidth + expandedContentWidth;
    const drawer = root.querySelector("[data-vanta-settings-drawer]");
    if (drawer && root.dataset.collapsed !== "1" && root.dataset.settingsOpen === "1") {
      const drawerStyle = getComputedStyle(drawer);
      const rowMinimum = [...drawer.children]
        .filter((row) => !row.hidden)
        .reduce((width, row) => Math.max(width, stylePixels(getComputedStyle(row), "minWidth")), 0);
      const drawerWidth = rowMinimum + stylePixels(drawerStyle, "paddingLeft") + stylePixels(drawerStyle, "paddingRight");
      target = Math.max(target, rootChrome + drawerWidth);
    }
    return Math.ceil(target);
  }

  function updatePanelContentWidth(root = getRoot()) {
    const content = root?.querySelector(".vanta-panel-content");
    if (!root || !content) return;
    window.cancelAnimationFrame(state.panelWidthFrame);
    state.panelWidthFrame = window.requestAnimationFrame(() => {
      state.panelWidthFrame = 0;
      if (!root.isConnected) return;
      const measuredContentWidth = Math.ceil(naturalFlexWidth(content));
      if (measuredContentWidth > 0) {
        content.style.setProperty("--vanta-panel-open-width", `${measuredContentWidth}px`);
      }
      const targetWidth = root.dataset.launcherOpen === "0"
        ? 0
        : Math.max(1, naturalPanelWidth(root, content, measuredContentWidth));
      if (Math.abs(targetWidth - state.panelTargetWidth) < 1 && root.style.width) return;
      const currentWidth = root.getBoundingClientRect().width;
      const visibilityMotion = root.dataset.launcherMotion === "1";
      root.style.setProperty("--vanta-panel-width-duration", visibilityMotion
        ? "420ms"
        : (targetWidth > currentWidth ? "280ms" : "340ms"));
      state.panelTargetWidth = targetWidth;
      root.style.width = `${targetWidth}px`;
    });
  }

  function observePanelMeasurements(root) {
    state.panelResizeObserver?.disconnect();
    state.panelMutationObserver?.disconnect();
    if (typeof ResizeObserver === "function") {
      state.panelResizeObserver = new ResizeObserver(() => updatePanelContentWidth(root));
      root.querySelectorAll([
        ".vanta-brand",
        ".vanta-connection-motion",
        ".vanta-participant-count",
        ".vanta-status-wrap",
        ".vanta-actions > button",
      ].join(",")).forEach((element) => state.panelResizeObserver.observe(element));
    }
    state.panelMutationObserver = new MutationObserver(() => updatePanelContentWidth(root));
    state.panelMutationObserver.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden", "data-collapsed", "data-launcher-open", "data-settings-open", "data-settings-closing"],
    });
  }

  function updateSettingsMotionMetrics(root = getRoot()) {
    const drawer = root?.querySelector("[data-vanta-settings-drawer]");
    if (!drawer) return;
    const style = getComputedStyle(drawer);
    const rows = [...drawer.children].filter((row) => !row.hidden);
    const gap = Number.parseFloat(style.rowGap) || 0;
    const rowsHeight = rows.reduce((total, row) => total + Math.max(row.offsetHeight, row.scrollHeight), 0);
    const openHeight = Math.ceil(Math.max(1, rowsHeight + Math.max(0, rows.length - 1) * gap + 9));
    drawer.style.setProperty("--vanta-settings-open-height", `${openHeight}px`);
  }

  function setBusy(busy) {
    const root = getRoot();
    if (!root) return;
    root.querySelectorAll("button").forEach((button) => { button.disabled = busy; });
    root.dataset.busy = busy ? "1" : "0";
  }

  function connectedStatus() {
    return "";
  }

  function deferredStatus(reason, direction) {
    if (reason === "function-editing") return "함수 편집 중";
    return "실행 중";
  }

  function shortErrorMessage(error, fallback = "오류") {
    const message = String(error?.message || error || "");
    if (/Token|토큰|사용량.*모두|quota/i.test(message)) return "토큰 부족";
    if (/최대 2MB|project is too large|stored chunk limit/i.test(message)) return "작품 2MB 초과";
    if (/256KB|changed chunk|project delta is too large|변경.*너무 큽|예상 전송량/i.test(message)) return "변경 용량 초과";
    if (/조각 수가 256|바뀐 작품 조각이 32|chunk count|delta size/i.test(message)) return "작품 조각 초과";
    if (/이미 다른 VANTA Live|하나만/.test(message)) return "다른 Live 사용 중";
    if (/최대 5명|참여.*자리/.test(message)) return "참여 인원 초과";
    if (/찾을 수 없|링크 코드|초대 링크|링크가 올바르지/.test(message)) return "링크 확인 필요";
    if (/만료/.test(message)) return "연결 만료";
    if (/함수 편집/.test(message)) return "함수 편집 중";
    if (/작품 실행|실행을 정지/.test(message)) return "실행 중";
    if (/복구 창/.test(message)) return "복구 창 확인";
    if (/링클|단축/.test(message)) return "링크 생성 실패";
    if (/채팅.*(빠르게|많)|too many|429/i.test(message)) return "잠시 후 전송";
    if (/채팅/.test(message)) return "채팅 전송 실패";
    if (/Firebase|실시간|서버|network|fetch/i.test(message)) return "연결 오류";
    if (/엔트리 편집기|작품 상태|작품 데이터/.test(message)) return "편집기 오류";
    if (/동시에 변경/.test(message)) return "잠시 후 재시도";
    return fallback;
  }

  function isProjectSizeError(error) {
    return /최대 2MB|256KB|조각 수가 256|작품 조각이 32|project is too large|stored chunk limit|changed chunk|project delta is too large|변경.*너무 큽|예상 전송량/i
      .test(String(error?.message || error || ""));
  }

  function updateProfileDockWidth() {
    const dock = getRoot()?.querySelector("[data-vanta-profile-dock]");
    const list = dock?.querySelector("[data-vanta-profile-list]");
    if (!dock || !list) return;
    const profiles = [...list.querySelectorAll(".vanta-profile")];
    const profileWidth = profiles.length * 30;
    const gapWidth = Math.max(0, profiles.length - 1) * 5;
    dock.style.setProperty("--vanta-profile-dock-width", `${Math.ceil(profileWidth + gapWidth)}px`);
  }

  function updateParticipantDisplay() {
    const area = getRoot()?.querySelector("[data-vanta-profile-area]");
    const dock = getRoot()?.querySelector("[data-vanta-profile-dock]");
    const list = dock?.querySelector("[data-vanta-profile-list]");
    const toggle = area?.querySelector("[data-vanta-profile-toggle]");
    const count = getRoot()?.querySelector("[data-vanta-participant-count]");
    if (count) count.textContent = `${Math.max(0, state.participantCount)}/${state.maxParticipants}`;
    if (!area || !dock || !list || !toggle) return;
    area.hidden = !state.connected;
    dock.dataset.open = state.profileDockOpen ? "1" : "0";
    dock.inert = !state.profileDockOpen;
    dock.setAttribute("aria-hidden", String(!state.profileDockOpen));
    toggle.setAttribute("aria-expanded", String(state.profileDockOpen));
    if (!state.connected) return;
    const active = [...state.participants]
      .filter((participant) => participant?.id)
      .sort((left, right) => {
        if (left.id === state.participantId) return -1;
        if (right.id === state.participantId) return 1;
        return Number(left.joinedAt || 0) - Number(right.joinedAt || 0);
      })
      .slice(0, state.maxParticipants);
    if (!active.some((participant) => participant.id === state.participantId)) {
      active.unshift({
        id: state.participantId,
        name: getDisplayName(),
        joinedAt: 0,
        isOwner: state.roomOwner,
      });
    }
    state.participantCount = active.length;
    if (count) count.textContent = `${state.participantCount}/${state.maxParticipants}`;
    list.replaceChildren(...active.slice(0, state.maxParticipants).map((participant) => {
      const name = String(participant.name || "참여자").trim().slice(0, 20) || "참여자";
      const self = participant.id === state.participantId;
      const owner = participant.isOwner === true;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "vanta-profile";
      button.dataset.participantId = participant.id;
      button.dataset.owner = owner ? "1" : "0";
      const color = normalizeProfileColor(participant.color || profileColor());
      button.style.setProperty("--vanta-profile-color", color);
      button.style.setProperty("--vanta-profile-foreground", contrastTextColor(color));
      button.setAttribute("aria-label", `${name}${owner ? ", 방장" : ""}${self ? ", 나" : ""}`);
      button.title = owner ? `${name} · 방장` : name;
      const initial = document.createElement("span");
      initial.className = "vanta-profile-initial";
      initial.textContent = Array.from(name)[0] || "?";
      button.append(initial);
      button.addEventListener("click", () => focusParticipantCursor(participant.id));
      return button;
    }));
    window.requestAnimationFrame(() => {
      updateProfileDockWidth();
      updatePanelContentWidth();
    });
  }

  async function focusParticipantCursor(participantId) {
    if (participantId === state.participantId) {
      setStatus("현재 위치", "success");
      return;
    }
    const cursor = state.remoteCursors.get(participantId);
    if (!cursor || (!cursor.sceneKey && !cursor.objectKey)) {
      setStatus("위치 정보 없음", "warning");
      return;
    }
    try {
      const result = await pageRequest("VANTA_FOCUS_CURSOR_CONTEXT", {
        sceneKey: cursor.sceneKey,
        objectKey: cursor.objectKey,
        area: cursor.area,
      }, 4000);
      if (!result?.focused) {
        setStatus("위치를 찾지 못함", "warning");
        return;
      }
      await refreshCursorContext();
      cursor.element?.animate?.([
        { filter: "brightness(1)" },
        { filter: "brightness(1.8)" },
        { filter: "brightness(1)" },
      ], { duration: 520, easing: "ease-out" });
      setStatus("위치로 이동", "success");
    } catch (error) {
      setStatus(shortErrorMessage(error, "이동 실패"), "warning");
    }
  }

  function showRetry(show) {
    const retry = getRoot()?.querySelector("[data-vanta-retry]");
    if (retry) retry.hidden = !show;
  }

  function entryRecoveryDialog() {
    const candidates = document.querySelectorAll("#EntryModal, #entry_global_dialog, #entry_global_modal, [role='dialog']");
    return [...candidates].find((element) => {
      const text = String(element.textContent || "").replace(/\s+/g, " ");
      const rect = element.getBoundingClientRect();
      return rect.width > 0
        && rect.height > 0
        && text.includes("저장하지 않고 종료한 작품")
        && text.includes("작품 복구");
    }) || null;
  }

  function hasEntryRecoveryDialog() {
    return Boolean(entryRecoveryDialog());
  }

  async function waitForEntryRecoveryDialog(timeoutMs = 10000) {
    const startedAt = Date.now();
    while (true) {
      const dialog = entryRecoveryDialog();
      if (!dialog) return;
      setStatus("복구 창 닫는 중…", "working");
      const cancel = dialog.querySelector(".entry-modal-cancelButton[data-value='cancel'], [data-value='cancel']");
      if (cancel) {
        cancel.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error("작품 복구 창을 자동으로 닫지 못했습니다.");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }
  }

  function watchEntryRecoveryDialog() {
    if (!initialToken || !document.documentElement) return;
    const dismiss = () => {
      const dialog = entryRecoveryDialog();
      const cancel = dialog?.querySelector(".entry-modal-cancelButton[data-value='cancel'], [data-value='cancel']");
      if (cancel) cancel.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    };
    const observer = new MutationObserver(dismiss);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    dismiss();
  }

  async function copyInviteLink() {
    const url = new URL("https://playentry.org/ws/new");
    url.searchParams.set("type", "normal");
    url.searchParams.set("mode", new URL(location.href).searchParams.get("mode") || "block");
    url.searchParams.set("lang", new URL(location.href).searchParams.get("lang") || "ko");
    url.searchParams.set("vanta", state.token);
    let copiedUrl = url.toString();
    let shortened = false;
    setStatus("링크 생성…", "working");
    try {
      const result = await sendRuntimeMessage({ type: "VANTA_SHORTEN_LINK", url: copiedUrl });
      copiedUrl = result.shortUrl;
      shortened = true;
    } catch (_) {}
    state.settingsLink = copiedUrl;
    state.settingsLinkError = "";
    updateSettingsDisplay();
    try {
      await navigator.clipboard.writeText(copiedUrl);
    } catch (error) {
      console.warn("[VANTA] 링크 복사 실패", error);
      setStatus("복사 실패", "warning");
      return {
        inviteUrl: url.toString(),
        copiedUrl,
        copied: false,
        shortened,
      };
    }
    if (shortened) setStatus("", "success");
    else setStatus("원본 링크 복사됨", "warning");
    return {
      inviteUrl: url.toString(),
      copiedUrl,
      copied: true,
      shortened,
    };
  }

  async function createShare() {
    setBusy(true);
    setStatus("준비 중…", "working");
    try {
      await waitForEntry();
      const project = await pageRequest("VANTA_EXPORT_PROJECT");
      if (project?.__vantaDeferred) throw new Error("작품 실행을 정지한 뒤 공유해 주세요.");
      const token = randomToken(32);
      await sendRuntimeMessage({
        type: "VANTA_CREATE_SESSION",
        session: {
          token,
          updatedBy: state.participantId,
          project,
          maxParticipants: state.maxParticipants,
        },
      });

      state.token = token;
      const copyResult = await copyInviteLink();
      if (copyResult.copied) setStatus("", "working");
      window.setTimeout(() => location.assign(copyResult.inviteUrl), copyResult.copied ? 250 : 700);
    } catch (error) {
      console.error("[VANTA] 공유 실패", error);
      setStatus(shortErrorMessage(error, "공유 실패"), "error");
      setBusy(false);
    }
  }

  function disconnect() {
    stopSession("VANTA 연결을 종료했습니다.");
    const url = new URL(location.href);
    url.searchParams.delete("vanta");
    history.replaceState(history.state, "", url);
    state.token = "";
    renderPanel();
  }

  const ICON_PATHS = Object.freeze({
    link: "M3.9 12c0-2.3 1.8-4.1 4.1-4.1h4v2H8c-1.2 0-2.1.9-2.1 2.1S6.8 14.1 8 14.1h4v2H8c-2.3 0-4.1-1.8-4.1-4.1zM8 13v-2h8v2H8zm8-5.1h-4v2h4c1.2 0 2.1.9 2.1 2.1s-.9 2.1-2.1 2.1h-4v2h4c2.3 0 4.1-1.8 4.1-4.1S18.3 7.9 16 7.9z",
    check: "M5 12.5l4.2 4L19 7.5",
    logout: "M5 5h6V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h6v-2H5V5zm12 2-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.59L17 17l5-5-5-5z",
    share: "M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11A2.99 2.99 0 1 0 15 5c0 .24.04.47.09.7L8.04 9.81A3 3 0 1 0 9 12c0-.24-.04-.47-.09-.7l7.12 4.16c.5-.46 1.17-.75 1.97-.75a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    sensors: "M7.76 16.24C6.67 15.15 6 13.65 6 12s.67-3.15 1.76-4.24l1.42 1.42C8.45 9.9 8 10.9 8 12s.45 2.1 1.17 2.83l-1.41 1.41zM16.24 7.76C17.33 8.85 18 10.35 18 12s-.67 3.15-1.76 4.24l-1.42-1.42C15.55 14.1 16 13.1 16 12s-.45-2.1-1.17-2.83l1.41-1.41zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm-7.07 7.07C2.61 18.76 1.17 15.56 1.17 12S2.61 5.24 4.93 2.93l1.42 1.42C4.39 6.31 3.17 9.01 3.17 12s1.22 5.69 3.18 7.65l-1.42 1.42zm14.14 0-1.42-1.42c1.96-1.96 3.18-4.66 3.18-7.65s-1.22-5.69-3.18-7.65l1.42-1.42c2.32 2.31 3.76 5.51 3.76 9.07s-1.44 6.76-3.76 9.07z",
    refresh: "M17.65 6.35A7.95 7.95 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
    group: "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z",
    sync: "M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.96-.69 2.79l1.46 1.46A7.94 7.94 0 0 0 20 12c0-4.42-3.58-8-8-8zm-6 8c0-1.01.25-1.96.69-2.79L5.23 7.75A7.94 7.94 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3c-3.31 0-6-2.69-6-6z",
    warning: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
    error: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z",
    chat: "M4 4h16c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H8l-5 4V6c0-1.1.9-2 2-2zm2 4v2h12V8H6zm0 4v2h8v-2H6z",
    send: "M2.01 21 23 12 2.01 3 2 10l15 2-15 2z",
    minimize: "M5 17h14v2H5v-2z",
    maximize: "M5 5h14v14H5V5zm2 2v10h10V7H7z",
    close: "M18.3 5.71 16.89 4.3 12 9.17 7.11 4.3 5.7 5.71 10.59 10.6 5.7 15.49 7.11 16.9 12 12.01 16.89 16.9 18.3 15.49 13.41 10.6z",
    cloud: "M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z",
    bolt: "M11 21h-1l1-7H7.5c-.88 0-.33-.75-.31-.78C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.4 0 .62.19.4.66C12.97 17.53 11 21 11 21z",
    settings: "M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.31 7.31 0 0 0-1.69-.98L14.5 2.42A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.49.49 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.08.66-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.12.22.38.31.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.04.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.58 1.69-.98l2.49 1c.23.08.49 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z",
  });

  function setElementIcon(element, name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICON_PATHS[name]);
    if (name === "check") {
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "2.4");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
    }
    svg.appendChild(path);
    element.replaceChildren(svg);
  }

  function setButtonIcon(button, name) {
    setElementIcon(button, name);
  }

  function iconButton(label, iconName, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `vanta-icon-button ${className}`.trim();
    button.setAttribute("aria-label", label);
    button.title = label;
    setButtonIcon(button, iconName);
    return button;
  }

  function showCopyConfirmation(button) {
    window.clearTimeout(copyFeedbackTimers.get(button));
    setButtonIcon(button, "check");
    button.classList.add("is-confirmed");
    button.setAttribute("aria-label", "복사 완료");
    button.title = "복사 완료";
    const timer = window.setTimeout(() => {
      setButtonIcon(button, "link");
      button.classList.remove("is-confirmed");
      button.setAttribute("aria-label", "링크 복사");
      button.title = "링크 복사";
      copyFeedbackTimers.delete(button);
    }, 1800);
    copyFeedbackTimers.set(button, timer);
  }

  function quotaText() {
    if (state.quotaLoading) return "확인 중…";
    if (state.quotaError) return "확인 실패";
    if (!state.quota) return "토큰";
    if (state.quota.paused) return "사용 정지";
    const percent = Math.max(0, Math.min(100, Number(state.quota.remainingPercent || 0)));
    const formatted = String(Math.round(percent));
    return `${state.quota.periodUnit || "주"} ${formatted}% 남음`;
  }

  function updateQuotaResetDisplay(root = getRoot()) {
    if (!root) return;
    const quotaResetRow = root.querySelector("[data-vanta-quota-reset-row]");
    const quotaResetCount = root.querySelector("[data-vanta-quota-reset-count]");
    const quotaResetButton = root.querySelector("[data-vanta-quota-reset-button]");
    const resetCredits = Math.max(0, Math.floor(Number(
      state.quota?.resetCredits ?? state.quota?.reset_credits ?? 0,
    )));
    if (quotaResetRow) quotaResetRow.hidden = resetCredits < 1 && !state.quotaResetComplete;
    if (quotaResetCount) quotaResetCount.textContent = `${resetCredits}회`;
    if (quotaResetButton) {
      quotaResetButton.disabled = state.quotaResetInFlight || state.quotaResetComplete || resetCredits < 1;
      quotaResetButton.textContent = state.quotaResetComplete
        ? "완료"
        : (state.quotaResetInFlight ? "초기화 중…" : "사용하기");
    }
  }

  function updateQuotaDisplay(root = getRoot()) {
    if (!root) return;
    const area = root.querySelector("[data-vanta-quota-area]");
    const detail = root.querySelector("[data-vanta-quota-detail]");
    const toggle = root.querySelector("[data-vanta-quota-toggle]");
    root.dataset.quotaOpen = state.quotaOpen ? "1" : "0";
    if (area) area.dataset.open = state.quotaOpen ? "1" : "0";
    if (detail) detail.textContent = quotaText();
    if (toggle) {
      toggle.setAttribute("aria-expanded", String(state.quotaOpen));
      toggle.title = state.quota ? `${state.quota.periodLabel} 토큰` : "토큰";
    }
    const settingsQuota = root.querySelector("[data-vanta-settings-quota]");
    if (settingsQuota) settingsQuota.textContent = settingsQuotaText();
    updateQuotaResetDisplay(root);
    window.requestAnimationFrame(() => {
      updatePanelContentWidth(root);
      window.setTimeout(() => updatePanelContentWidth(root), 340);
    });
  }

  async function loadQuota(root = getRoot()) {
    const sequence = ++state.quotaRequestSequence;
    state.quotaLoading = true;
    state.quotaError = "";
    updateQuotaDisplay(root);
    try {
      const quota = await sendRuntimeMessage({ type: "VANTA_GET_QUOTA" });
      if (sequence !== state.quotaRequestSequence) return;
      state.quota = quota;
    } catch (error) {
      if (sequence !== state.quotaRequestSequence) return;
      state.quotaError = shortErrorMessage(error, "토큰 확인 실패");
    } finally {
      if (sequence === state.quotaRequestSequence) {
        state.quotaLoading = false;
        updateQuotaDisplay(root);
      }
    }
  }

  async function useQuotaReset(root = getRoot()) {
    if (state.quotaResetInFlight || Number(state.quota?.resetCredits || 0) < 1) return;
    window.clearTimeout(state.quotaResetFeedbackTimer);
    state.quotaResetComplete = false;
    state.quotaResetInFlight = true;
    updateSettingsDisplay(root);
    try {
      state.quota = await sendRuntimeMessage({ type: "VANTA_USE_QUOTA_RESET" });
      state.quotaError = "";
      state.quotaResetComplete = true;
      state.quotaResetFeedbackTimer = window.setTimeout(() => {
        state.quotaResetComplete = false;
        state.quotaResetFeedbackTimer = 0;
        updateSettingsDisplay(root);
      }, 2200);
      setStatus("토큰 초기화 완료", "success");
    } catch (error) {
      state.quotaResetComplete = false;
      setStatus(shortErrorMessage(error, "토큰 초기화 실패"), "warning");
      await loadQuota(root);
    } finally {
      state.quotaResetInFlight = false;
      updateQuotaDisplay(root);
      updateSettingsDisplay(root);
    }
  }

  function toggleQuota(root = getRoot()) {
    state.quotaOpen = !state.quotaOpen;
    updateQuotaDisplay(root);
    if (state.quotaOpen) loadQuota(root);
  }

  function settingsQuotaText() {
    if (state.quotaLoading) return "확인 중";
    if (state.quotaError) return "확인 실패";
    if (!state.quota) return "—";
    if (state.quota.paused) return "사용 정지";
    return `${state.quota.periodUnit || "주"} ${Math.round(Math.max(0, Math.min(100, Number(state.quota.remainingPercent || 0))))}% 남음`;
  }

  function updateSettingsDisplay(root = getRoot()) {
    if (!root) return;
    root.dataset.settingsOpen = state.settingsOpen ? "1" : "0";
    const drawer = root.querySelector("[data-vanta-settings-drawer]");
    const toggle = root.querySelector("[data-vanta-settings-toggle]");
    const quota = root.querySelector("[data-vanta-settings-quota]");
    const link = root.querySelector("[data-vanta-settings-link]");
    const linkCopy = root.querySelector(".vanta-settings-link-copy");
    const anonymousToggle = root.querySelector("[data-vanta-anonymous-toggle]");
    const liveCursorToggle = root.querySelector("[data-vanta-live-cursor-toggle]");
    const colorInput = root.querySelector("[data-vanta-color-input]");
    const colorPreview = root.querySelector("[data-vanta-color-preview]");
    if (drawer) {
      drawer.setAttribute("aria-hidden", String(!state.settingsOpen));
      drawer.inert = !state.settingsOpen;
    }
    if (toggle) {
      toggle.dataset.active = state.settingsOpen ? "1" : "0";
      toggle.setAttribute("aria-expanded", String(state.settingsOpen));
    }
    if (quota) quota.textContent = settingsQuotaText();
    updateQuotaResetDisplay(root);
    if (link) {
      link.textContent = state.settingsLinkLoading
        ? "불러오는 중…"
        : state.settingsLinkError || state.settingsLink || (state.connected ? "링크 준비" : "Live 시작 후 생성");
      link.title = state.settingsLink || "";
    }
    if (linkCopy) linkCopy.disabled = !state.connected || state.settingsLinkLoading;
    if (anonymousToggle) {
      anonymousToggle.dataset.enabled = state.anonymousMode ? "1" : "0";
      anonymousToggle.setAttribute("aria-checked", String(state.anonymousMode));
    }
    if (liveCursorToggle) {
      liveCursorToggle.dataset.enabled = state.liveCursorMode ? "1" : "0";
      liveCursorToggle.setAttribute("aria-checked", String(state.liveCursorMode));
      const liveCursorRow = liveCursorToggle.closest(".vanta-settings-live-cursor");
      if (liveCursorRow) liveCursorRow.dataset.enabled = state.liveCursorMode ? "1" : "0";
      const liveCursorLocked = !state.connected || !state.roomOwner;
      liveCursorToggle.dataset.forbidden = liveCursorLocked ? "1" : "0";
      liveCursorToggle.disabled = state.roomSettingsSaving || liveCursorLocked;
      liveCursorToggle.title = !state.connected ? "Live에서 설정할 수 있어요" : (liveCursorLocked ? "방장만 변경할 수 있어요" : "");
    }
    if (colorInput && document.activeElement !== colorInput) colorInput.value = state.userColor.slice(1).toUpperCase();
    if (colorPreview) colorPreview.style.setProperty("--vanta-user-color", state.userColor);
    root.querySelectorAll("[data-vanta-room-size]").forEach((button) => {
      button.dataset.selected = Number(button.dataset.vantaRoomSize) === state.maxParticipants ? "1" : "0";
      const ownerLocked = state.connected && !state.roomOwner;
      button.dataset.forbidden = ownerLocked ? "1" : "0";
      button.disabled = state.roomSettingsSaving || ownerLocked;
      button.title = ownerLocked ? "방장만 변경할 수 있어요" : "";
    });
    window.requestAnimationFrame(() => updateSettingsMotionMetrics(root));
  }

  async function loadRoomSettings() {
    if (!state.connected || !state.token || state.roomSettingsLoading) return;
    state.roomSettingsLoading = true;
    updateSettingsDisplay();
    try {
      const settings = await sendRuntimeMessage({ type: "VANTA_GET_ROOM_SETTINGS", token: state.token, participantId: state.participantId });
      state.maxParticipants = Math.max(2, Math.min(5, Number(settings.maxParticipants || 5)));
      await applyLiveCursorTransport(settings.liveCursor === true);
      state.roomOwner = settings.isOwner === true;
      updateParticipantDisplay();
    } catch (error) {
      setStatus(shortErrorMessage(error, "설정 확인 실패"), "warning");
    } finally {
      state.roomSettingsLoading = false;
      updateSettingsDisplay();
    }
  }

  function inviteUrl() {
    if (!state.token) return "";
    const url = new URL("https://playentry.org/ws/new");
    url.searchParams.set("type", "normal");
    url.searchParams.set("mode", new URL(location.href).searchParams.get("mode") || "block");
    url.searchParams.set("lang", new URL(location.href).searchParams.get("lang") || "ko");
    url.searchParams.set("vanta", state.token);
    return url.toString();
  }

  async function loadSettingsLink() {
    if (!state.connected || !state.token || state.settingsLinkLoading || state.settingsLink) return;
    const sourceUrl = inviteUrl();
    state.settingsLinkLoading = true;
    state.settingsLinkError = "";
    updateSettingsDisplay();
    try {
      const result = await sendRuntimeMessage({ type: "VANTA_SHORTEN_LINK", url: sourceUrl });
      state.settingsLink = String(result.shortUrl || sourceUrl);
    } catch (_) {
      state.settingsLink = sourceUrl;
      state.settingsLinkError = "";
    } finally {
      state.settingsLinkLoading = false;
      updateSettingsDisplay();
    }
  }

  async function copySettingsLink(button) {
    if (!state.settingsLink) await loadSettingsLink();
    const value = state.settingsLink || inviteUrl();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showCopyConfirmation(button);
    } catch (_) {
      setStatus("복사 실패", "warning");
    }
  }

  async function setRoomSize(maxParticipants) {
    if (state.roomSettingsSaving || (state.connected && !state.roomOwner)) return;
    const next = Math.max(2, Math.min(5, Number(maxParticipants || 5)));
    if (next === state.maxParticipants) return;
    if (!state.connected) {
      state.maxParticipants = next;
      saveUiSettings();
      updateParticipantDisplay();
      updateSettingsDisplay();
      return;
    }
    state.roomSettingsSaving = true;
    updateSettingsDisplay();
    try {
      const settings = await sendRuntimeMessage({
        type: "VANTA_UPDATE_ROOM_SETTINGS",
        token: state.token,
        participantId: state.participantId,
        maxParticipants: next,
      });
      state.maxParticipants = Number(settings.maxParticipants || next);
      updateParticipantDisplay();
    } catch (error) {
      setStatus(shortErrorMessage(error, "인원 설정 실패"), "warning");
    } finally {
      state.roomSettingsSaving = false;
      updateSettingsDisplay();
    }
  }

  function refreshOwnIdentity() {
    const name = getDisplayName() || "익명";
    const color = profileColor();
    const own = { id: state.participantId, name, color, joinedAt: 0, isOwner: state.roomOwner };
    const index = state.participants.findIndex((participant) => participant?.id === state.participantId);
    if (index >= 0) state.participants[index] = { ...state.participants[index], name, color };
    else if (state.connected) state.participants.unshift(own);
    state.cursorDirty = true;
    updateParticipantDisplay();
    updateSettingsDisplay();
    if (state.connected) heartbeatLive();
  }

  function setAnonymousMode(enabled) {
    state.anonymousMode = enabled === true;
    saveUiSettings();
    refreshOwnIdentity();
  }

  function restartRealtimeStream() {
    const previous = state.streamPort;
    state.streamPort = null;
    try { previous?.disconnect(); } catch (_) {}
    if (state.connected && !state.stopped) startRealtimeStream();
  }

  function disableLiveCursorAfterFailure(error) {
    if (!state.liveCursorMode && !state.liveCursorDesired) return;
    state.liveCursorDesired = false;
    window.clearTimeout(state.liveCursorRetryTimer);
    state.liveCursorRetryTimer = 0;
    state.liveCursorMode = false;
    if (state.connected) {
      sendRuntimeMessage({
        type: "VANTA_SET_LIVE_CURSOR",
        token: state.token,
        participantId: state.participantId,
        connectionId: state.connectionId,
        enabled: false,
      }).catch(() => {});
    }
    updateSettingsDisplay();
    restartRealtimeStream();
    clearRemoteCursors();
    const message = shortErrorMessage(error, "Live 커서를 사용할 수 없어 꺼졌습니다.");
    setStatus(message === "토큰 부족" ? "토큰이 부족해 Live 커서를 사용할 수 없습니다." : message, "warning");
  }

  async function applyLiveCursorTransport(enabled) {
    const next = enabled === true;
    state.liveCursorDesired = next;
    window.clearTimeout(state.liveCursorRetryTimer);
    state.liveCursorRetryTimer = 0;
    if (!state.connected) return false;
    if (state.liveCursorTransition) return state.liveCursorTransition;

    const epoch = state.connectionEpoch;
    const token = state.token;
    const transition = (async () => {
      while (isCurrentConnection(epoch, token) && state.liveCursorDesired !== state.liveCursorMode) {
        const target = state.liveCursorDesired;
        try {
          const result = await sendRuntimeMessage({
            type: "VANTA_SET_LIVE_CURSOR",
            token: state.token,
            participantId: state.participantId,
            connectionId: state.connectionId,
            enabled: target,
          });
          if (!isCurrentConnection(epoch, token)) return false;
          state.liveCursorMode = result?.enabled === true;
          if (result?.quota) {
            state.quota = result.quota;
            state.quotaError = "";
            updateQuotaDisplay();
          }
          state.cursorDirty = true;
          if (!state.liveCursorMode) clearRemoteCursors();
          updateSettingsDisplay();
          restartRealtimeStream();
        } catch (error) {
          if (!isCurrentConnection(epoch, token)) return false;
          state.liveCursorMode = false;
          updateSettingsDisplay();
          clearRemoteCursors();
          const message = shortErrorMessage(error, "Live 커서를 켤 수 없습니다.");
          setStatus(message === "토큰 부족" ? "토큰이 부족해 Live 커서를 사용할 수 없습니다." : message, "warning");
          if (target && state.liveCursorDesired) {
            state.liveCursorRetryTimer = window.setTimeout(() => {
              state.liveCursorRetryTimer = 0;
              applyLiveCursorTransport(state.liveCursorDesired);
            }, 5000);
          }
          return false;
        }
      }
      return state.liveCursorMode;
    })();
    state.liveCursorTransition = transition;
    try {
      return await transition;
    } finally {
      if (state.liveCursorTransition === transition) state.liveCursorTransition = null;
      if (isCurrentConnection(epoch, token)
        && !state.liveCursorRetryTimer
        && state.liveCursorDesired !== state.liveCursorMode) {
        queueMicrotask(() => applyLiveCursorTransport(state.liveCursorDesired));
      }
    }
  }

  async function setLiveCursorMode(enabled) {
    if (!state.connected || !state.roomOwner || state.roomSettingsSaving) return;
    const next = enabled === true;
    if (next === state.liveCursorMode) return;
    state.roomSettingsSaving = true;
    updateSettingsDisplay();
    try {
      const settings = await sendRuntimeMessage({
        type: "VANTA_UPDATE_ROOM_SETTINGS",
        token: state.token,
        participantId: state.participantId,
        liveCursor: next,
      });
      await applyLiveCursorTransport(settings.liveCursor === true);
    } catch (error) {
      const message = shortErrorMessage(error, "Live 커서를 변경할 수 없습니다.");
      setStatus(message === "토큰 부족" ? "토큰이 부족한 참여자가 있어 Live 커서를 켤 수 없습니다." : message, "warning");
    } finally {
      state.roomSettingsSaving = false;
      updateSettingsDisplay();
    }
  }

  function setUserColor(value) {
    const normalized = normalizeProfileColor(`#${String(value || "").replace(/[^0-9A-Fa-f]/g, "").slice(0, 6)}`);
    state.userColor = normalized;
    saveUiSettings();
    refreshOwnIdentity();
  }

  function createSettingsDrawer() {
    const drawer = document.createElement("div");
    drawer.className = "vanta-settings-drawer";
    drawer.dataset.vantaSettingsDrawer = "1";
    drawer.setAttribute("aria-hidden", String(!state.settingsOpen));
    drawer.inert = !state.settingsOpen;

    const roomRow = document.createElement("div");
    roomRow.className = "vanta-settings-row";
    const roomLabel = document.createElement("span");
    roomLabel.textContent = "최대 인원";
    const choices = document.createElement("div");
    choices.className = "vanta-room-size";
    for (let size = 2; size <= 5; size += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = String(size);
      button.dataset.vantaRoomSize = String(size);
      button.setAttribute("aria-label", `최대 ${size}명`);
      button.addEventListener("click", () => setRoomSize(size));
      choices.append(button);
    }
    roomRow.append(roomLabel, choices);

    const quotaRow = document.createElement("div");
    quotaRow.className = "vanta-settings-row";
    const quotaLabel = document.createElement("span");
    quotaLabel.textContent = "토큰";
    const quotaValue = document.createElement("strong");
    quotaValue.dataset.vantaSettingsQuota = "1";
    quotaValue.textContent = settingsQuotaText();
    quotaRow.append(quotaLabel, quotaValue);

    const quotaResetRow = document.createElement("div");
    quotaResetRow.className = "vanta-settings-row vanta-quota-reset-row";
    quotaResetRow.dataset.vantaQuotaResetRow = "1";
    quotaResetRow.hidden = true;
    const quotaResetLabel = document.createElement("span");
    quotaResetLabel.textContent = "토큰 초기화";
    const quotaResetActions = document.createElement("span");
    quotaResetActions.className = "vanta-quota-reset-actions";
    const quotaResetCount = document.createElement("strong");
    quotaResetCount.dataset.vantaQuotaResetCount = "1";
    quotaResetCount.textContent = "0회";
    const quotaResetButton = document.createElement("button");
    quotaResetButton.type = "button";
    quotaResetButton.className = "vanta-secondary vanta-quota-reset-button";
    quotaResetButton.dataset.vantaQuotaResetButton = "1";
    quotaResetButton.textContent = "사용하기";
    quotaResetButton.addEventListener("click", () => useQuotaReset());
    quotaResetActions.append(quotaResetCount, quotaResetButton);
    quotaResetRow.append(quotaResetLabel, quotaResetActions);

    const linkRow = document.createElement("div");
    linkRow.className = "vanta-settings-row vanta-settings-link-row";
    const linkText = document.createElement("span");
    linkText.className = "vanta-settings-link";
    linkText.dataset.vantaSettingsLink = "1";
    const linkCopy = iconButton("단축 링크 복사", "link", "vanta-settings-link-copy");
    linkCopy.addEventListener("click", () => copySettingsLink(linkCopy));
    linkRow.append(linkText, linkCopy);

    const anonymousRow = document.createElement("div");
    anonymousRow.className = "vanta-settings-row";
    const anonymousLabel = document.createElement("span");
    anonymousLabel.textContent = "익명 모드";
    const anonymousToggle = document.createElement("button");
    anonymousToggle.type = "button";
    anonymousToggle.className = "vanta-switch";
    anonymousToggle.dataset.vantaAnonymousToggle = "1";
    anonymousToggle.setAttribute("role", "switch");
    anonymousToggle.setAttribute("aria-label", "익명 모드");
    anonymousToggle.addEventListener("click", () => setAnonymousMode(!state.anonymousMode));
    anonymousToggle.append(document.createElement("span"));
    anonymousRow.append(anonymousLabel, anonymousToggle);

    const liveCursorRow = document.createElement("div");
    liveCursorRow.className = "vanta-settings-row vanta-settings-live-cursor";
    const liveCursorLabel = document.createElement("span");
    liveCursorLabel.className = "vanta-live-cursor-label";
    const liveCursorText = document.createElement("span");
    liveCursorText.textContent = "Live 커서";
    const liveCursorDescription = document.createElement("small");
    liveCursorDescription.textContent = "OFF 시 토큰 절약";
    liveCursorLabel.append(liveCursorText, liveCursorDescription);
    const liveCursorToggle = document.createElement("button");
    liveCursorToggle.type = "button";
    liveCursorToggle.className = "vanta-switch";
    liveCursorToggle.dataset.vantaLiveCursorToggle = "1";
    liveCursorToggle.setAttribute("role", "switch");
    liveCursorToggle.setAttribute("aria-label", "Live 커서");
    liveCursorToggle.addEventListener("click", () => setLiveCursorMode(!state.liveCursorMode));
    liveCursorToggle.append(document.createElement("span"));
    liveCursorRow.append(liveCursorLabel, liveCursorToggle);

    const colorRow = document.createElement("label");
    colorRow.className = "vanta-settings-row vanta-color-row";
    const colorLabel = document.createElement("span");
    colorLabel.textContent = "프로필 · 포인터 색상";
    const colorControl = document.createElement("span");
    colorControl.className = "vanta-color-control";
    const colorPreview = document.createElement("span");
    colorPreview.className = "vanta-color-preview";
    colorPreview.dataset.vantaColorPreview = "1";
    const colorPrefix = document.createElement("span");
    colorPrefix.className = "vanta-color-prefix";
    colorPrefix.textContent = "#";
    const colorInput = document.createElement("input");
    colorInput.className = "vanta-color-input";
    colorInput.dataset.vantaColorInput = "1";
    colorInput.inputMode = "text";
    colorInput.maxLength = 6;
    colorInput.autocomplete = "off";
    colorInput.spellcheck = false;
    colorInput.setAttribute("aria-label", "프로필과 포인터 색상 6자리 HEX");
    colorInput.addEventListener("input", () => {
      colorInput.value = colorInput.value.replace(/[^0-9A-Fa-f]/g, "").slice(0, 6).toUpperCase();
      if (colorInput.value.length === 6) colorPreview.style.setProperty("--vanta-user-color", `#${colorInput.value}`);
    });
    const commitColor = () => {
      if (/^[0-9A-Fa-f]{6}$/.test(colorInput.value)) setUserColor(colorInput.value);
      else colorInput.value = state.userColor.slice(1).toUpperCase();
    };
    colorInput.addEventListener("change", commitColor);
    colorInput.addEventListener("blur", commitColor);
    colorInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitColor();
        colorInput.blur();
      }
    });
    colorControl.append(colorPreview, colorPrefix, colorInput);
    colorRow.append(colorLabel, colorControl);

    drawer.append(roomRow, quotaRow, quotaResetRow, linkRow, anonymousRow, liveCursorRow, colorRow);
    return drawer;
  }

  function tutorialSteps() {
    const live = isVantaWorkspace();
    return [
      {
        selector: live ? "" : "[data-vanta-header-launcher-button]",
        eyebrow: "처음 만나는 VANTA",
        title: live ? "함께 만드는 워크스페이스" : "필요할 때 VANTA를 여세요",
        description: live
          ? "VANTA로 엔트리 작품을 최대 5명과 실시간으로 편집할 수 있어요. 핵심 기능만 빠르게 살펴볼게요."
          : "엔트리 상단의 VANTA 버튼을 누르면 공동 편집 패널이 부드럽게 열려요.",
      },
      {
        selector: "#vanta-root .vanta-top-row",
        eyebrow: "1 · VANTA 패널",
        title: "필요한 기능은 모두 여기에",
        description: "상단의 VANTA 로고를 누르면 패널을 접거나 다시 펼칠 수 있어요.",
      },
      live ? {
        selector: "[data-vanta-participant-count]",
        eyebrow: "2 · Live 상태",
        title: "함께 접속한 인원을 확인하세요",
        description: "현재 참여 인원과 연결 상태가 실시간으로 표시돼요. 참여자 버튼에서는 함께 작업 중인 사람을 확인할 수 있어요.",
      } : {
        selector: ".vanta-share-button",
        eyebrow: "2 · Live 시작",
        title: "공유 버튼 하나면 준비 완료",
        description: "공유 버튼을 누르면 현재 작품으로 Live가 만들어지고, 초대용 단축 링크가 준비돼요.",
      },
      {
        selector: ".vanta-settings-toggle",
        eyebrow: "3 · 설정",
        title: "방과 내 프로필을 설정하세요",
        description: "최대 인원, 익명 모드, Live 커서와 프로필 색상을 언제든 바꿀 수 있어요.",
      },
    ];
  }

  function closeTutorial() {
    const tutorial = document.getElementById("vanta-tutorial");
    tutorial?._vantaCleanup?.();
    tutorial?.remove();
    state.tutorialPending = false;
    chrome.storage.local.set({ [TUTORIAL_COMPLETED_KEY]: true }).catch(() => {});
  }

  function showTutorial() {
    if (!state.tutorialPending || document.getElementById("vanta-tutorial")) return;
    const root = getRoot();
    if (!root) return;
    state.panelCollapsed = false;
    root.dataset.collapsed = "0";
    root.querySelector(".vanta-brand")?.setAttribute("aria-expanded", "true");
    updatePanelContentWidth(root);

    const steps = tutorialSteps();
    state.tutorialStep = 0;
    const tutorial = document.createElement("aside");
    tutorial.id = "vanta-tutorial";
    tutorial.setAttribute("role", "dialog");
    tutorial.setAttribute("aria-modal", "true");
    tutorial.setAttribute("aria-labelledby", "vanta-tutorial-title");

    const shield = document.createElement("div");
    shield.className = "vanta-tutorial-shield";
    const highlight = document.createElement("div");
    highlight.className = "vanta-tutorial-highlight";
    const card = document.createElement("div");
    card.className = "vanta-tutorial-card";
    const logo = document.createElement("img");
    logo.className = "vanta-tutorial-logo";
    logo.src = chrome.runtime.getURL("assets/vanta.svg");
    logo.alt = "VANTA";
    const eyebrow = document.createElement("span");
    eyebrow.className = "vanta-tutorial-eyebrow";
    const title = document.createElement("h2");
    title.id = "vanta-tutorial-title";
    const description = document.createElement("p");
    const progress = document.createElement("div");
    progress.className = "vanta-tutorial-progress";
    progress.setAttribute("aria-label", "튜토리얼 진행 상태");
    const footer = document.createElement("div");
    footer.className = "vanta-tutorial-footer";
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "vanta-tutorial-skip";
    skip.textContent = "건너뛰기";
    const navigation = document.createElement("div");
    navigation.className = "vanta-tutorial-navigation";
    const previous = document.createElement("button");
    previous.type = "button";
    previous.textContent = "이전";
    const next = document.createElement("button");
    next.type = "button";
    next.className = "vanta-tutorial-next";
    navigation.append(previous, next);
    footer.append(skip, navigation);
    card.append(logo, eyebrow, title, description, progress, footer);
    tutorial.append(shield, highlight, card);
    (document.body || document.documentElement).appendChild(tutorial);

    let activeTarget = null;
    const position = () => {
      if (!activeTarget?.isConnected) return;
      const rect = activeTarget.getBoundingClientRect();
      const padding = 7;
      highlight.style.left = `${Math.max(4, rect.left - padding)}px`;
      highlight.style.top = `${Math.max(4, rect.top - padding)}px`;
      highlight.style.width = `${Math.max(24, Math.min(innerWidth - 8, rect.width + padding * 2))}px`;
      highlight.style.height = `${Math.max(24, rect.height + padding * 2)}px`;
    };

    const renderStep = () => {
      const step = steps[state.tutorialStep];
      activeTarget = step.selector ? document.querySelector(step.selector) : null;
      tutorial.dataset.hasTarget = activeTarget ? "1" : "0";
      highlight.hidden = !activeTarget;
      eyebrow.textContent = step.eyebrow;
      title.textContent = step.title;
      description.textContent = step.description;
      progress.innerHTML = steps.map((_, index) => `<i${index === state.tutorialStep ? ' data-active="1"' : ""}></i>`).join("");
      previous.hidden = state.tutorialStep === 0;
      next.textContent = state.tutorialStep === steps.length - 1 ? "VANTA 시작하기" : "다음";
      position();
      window.requestAnimationFrame(() => next.focus({ preventScroll: true }));
    };

    const finish = () => closeTutorial();
    skip.addEventListener("click", finish);
    previous.addEventListener("click", () => {
      state.tutorialStep = Math.max(0, state.tutorialStep - 1);
      renderStep();
    });
    next.addEventListener("click", () => {
      if (state.tutorialStep >= steps.length - 1) {
        finish();
        return;
      }
      if (!isVantaWorkspace() && state.tutorialStep === 0) setPanelVisible(true);
      state.tutorialStep += 1;
      renderStep();
    });
    const onKeyDown = (event) => {
      if (event.key === "Escape") finish();
    };
    window.addEventListener("resize", position, { passive: true });
    document.addEventListener("scroll", position, true);
    document.addEventListener("keydown", onKeyDown, true);
    tutorial._vantaCleanup = () => {
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
    renderStep();
  }

  function renderPanel() {
    state.panelResizeObserver?.disconnect();
    state.panelMutationObserver?.disconnect();
    state.panelResizeObserver = null;
    state.panelMutationObserver = null;
    state.panelTargetWidth = 0;
    getRoot()?.remove();
    const root = document.createElement("section");
    root.id = "vanta-root";
    root.setAttribute("aria-label", "VANTA 공동 편집");

    root.dataset.live = isVantaWorkspace() ? "1" : "0";
    root.dataset.launcherOpen = state.panelVisible ? "1" : "0";
    root.dataset.collapsed = state.panelCollapsed ? "1" : "0";
    root.dataset.quotaOpen = state.quotaOpen ? "1" : "0";
    root.dataset.settingsOpen = state.settingsOpen ? "1" : "0";
    const brand = document.createElement("button");
    brand.type = "button";
    brand.className = "vanta-brand";
    const brandImage = document.createElement("img");
    brandImage.src = chrome.runtime.getURL("assets/vanta.svg");
    brandImage.alt = "";
    brandImage.draggable = false;
    brand.append(brandImage);
    brand.setAttribute("aria-label", state.panelCollapsed ? "VANTA 패널 펼치기" : "VANTA 패널 접기");
    brand.setAttribute("aria-expanded", String(!state.panelCollapsed));
    brand.addEventListener("click", () => {
      state.panelCollapsed = !state.panelCollapsed;
      if (state.panelCollapsed) {
        window.clearTimeout(state.settingsCloseTimer);
        state.settingsCloseTimer = 0;
        delete root.dataset.settingsClosing;
        state.profileDockOpen = false;
        state.quotaOpen = false;
        state.settingsOpen = false;
        updateQuotaDisplay(root);
        updateSettingsDisplay(root);
        updateParticipantDisplay();
      }
      root.dataset.collapsed = state.panelCollapsed ? "1" : "0";
      brand.setAttribute("aria-label", state.panelCollapsed ? "VANTA 패널 펼치기" : "VANTA 패널 접기");
      brand.setAttribute("aria-expanded", String(!state.panelCollapsed));
      updateHeaderLauncherState();
      updatePanelContentWidth(root);
    });
    const status = document.createElement("span");
    status.dataset.vantaStatus = "1";

    const statusIcon = document.createElement("span");
    statusIcon.className = "vanta-status-icon";
    statusIcon.dataset.vantaStatusIcon = "1";

    const statusWrap = document.createElement("span");
    statusWrap.className = "vanta-status-wrap";
    statusWrap.dataset.vantaStatusWrap = "1";
    statusWrap.append(statusIcon, status);

    const connectionMotion = document.createElement("span");
    connectionMotion.className = "vanta-connection-motion";
    connectionMotion.setAttribute("aria-hidden", "true");
    const participantCount = document.createElement("span");
    participantCount.className = "vanta-participant-count";
    participantCount.dataset.vantaParticipantCount = "1";
    participantCount.textContent = `${state.participantCount}/${state.maxParticipants}`;
    participantCount.title = "현재 참여 인원";

    const actions = document.createElement("div");
    actions.className = "vanta-actions";
    const settings = iconButton("설정", "cloud", "vanta-settings-toggle");
    settings.dataset.vantaSettingsToggle = "1";
    settings.setAttribute("aria-expanded", String(state.settingsOpen));
    settings.addEventListener("click", () => {
      window.clearTimeout(state.settingsCloseTimer);
      state.settingsCloseTimer = 0;
      updatePanelContentWidth(root);
      updateSettingsMotionMetrics(root);
      const opening = !state.settingsOpen;
      if (opening) delete root.dataset.settingsClosing;
      else root.dataset.settingsClosing = "1";
      state.settingsOpen = opening;
      if (state.settingsOpen) {
        loadQuota(root);
        if (state.connected) {
          loadRoomSettings();
          loadSettingsLink();
        }
      }
      updateSettingsDisplay(root);
      window.requestAnimationFrame(() => {
        updateSettingsMotionMetrics(root);
        updatePanelContentWidth(root);
      });
      state.settingsCloseTimer = window.setTimeout(() => {
        delete root.dataset.settingsClosing;
        state.settingsCloseTimer = 0;
        updatePanelContentWidth(root);
      }, 540);
    });
    if (isVantaWorkspace()) {
      const chat = iconButton("채팅", "chat", "vanta-chat-toggle");
      chat.dataset.vantaChatToggle = "1";
      chat.addEventListener("click", () => toggleChat());
      const copy = iconButton("링크 복사", "link");
      copy.addEventListener("click", async () => {
        copy.disabled = true;
        try {
          const result = await copyInviteLink();
          if (result.copied) showCopyConfirmation(copy);
        } catch (error) {
          setStatus(shortErrorMessage(error, "복사 실패"), "error");
        } finally {
          copy.disabled = false;
        }
      });
      const end = iconButton("연결 끝내기", "logout", "vanta-secondary vanta-disconnect-button");
      end.addEventListener("click", disconnect);
      const retry = iconButton("다시 연결", "refresh", "vanta-secondary");
      retry.dataset.vantaRetry = "1";
      retry.hidden = true;
      retry.addEventListener("click", () => joinSession());
      actions.append(chat, copy, settings, retry, end);
      status.textContent = "연결 중…";
      setElementIcon(statusIcon, "sync");
    } else {
      const share = iconButton("공유하기", "sensors", "vanta-share-button");
      share.addEventListener("click", createShare);
      actions.append(settings, share);
      statusWrap.hidden = true;
    }
    const panelContent = document.createElement("div");
    panelContent.className = `vanta-panel-content${isVantaWorkspace() ? "" : " vanta-share-content"}`;
    if (isVantaWorkspace()) panelContent.append(connectionMotion, participantCount);
    panelContent.append(statusWrap, actions);
    const profileArea = document.createElement("div");
    profileArea.className = "vanta-profile-area";
    profileArea.dataset.vantaProfileArea = "1";
    profileArea.hidden = !state.connected || !isVantaWorkspace();
    const profileToggle = iconButton("참여자 보기", "group", "vanta-profile-toggle");
    profileToggle.dataset.vantaProfileToggle = "1";
    profileToggle.setAttribute("aria-expanded", String(state.profileDockOpen));
    const profileDock = document.createElement("div");
    profileDock.className = "vanta-profile-dock";
    profileDock.dataset.vantaProfileDock = "1";
    profileDock.dataset.open = state.profileDockOpen ? "1" : "0";
    profileDock.inert = !state.profileDockOpen;
    profileDock.setAttribute("aria-hidden", String(!state.profileDockOpen));
    const profileList = document.createElement("div");
    profileList.className = "vanta-profile-list";
    profileList.dataset.vantaProfileList = "1";
    profileDock.append(profileList);
    profileToggle.addEventListener("click", () => {
      state.profileDockOpen = !state.profileDockOpen;
      profileDock.dataset.open = state.profileDockOpen ? "1" : "0";
      profileDock.inert = !state.profileDockOpen;
      profileDock.setAttribute("aria-hidden", String(!state.profileDockOpen));
      profileToggle.setAttribute("aria-expanded", String(state.profileDockOpen));
      if (state.profileDockOpen) window.requestAnimationFrame(updateProfileDockWidth);
    });
    profileArea.append(profileToggle, profileDock);
    const topRow = document.createElement("div");
    topRow.className = "vanta-top-row";
    topRow.append(brand, panelContent);
    root.append(topRow, createSettingsDrawer(), profileArea);
    document.getElementById("vanta-chat")?.remove();
    (document.body || document.documentElement).appendChild(root);
    if (isVantaWorkspace()) (document.body || document.documentElement).appendChild(createChatPanel());
    updateParticipantDisplay();
    renderChat();
    updateQuotaDisplay(root);
    updateSettingsDisplay(root);
    observePanelMeasurements(root);
    updatePanelContentWidth(root);
  }

  function normalizeProfileColor(value) {
    const color = String(value || "").toUpperCase();
    return /^#[0-9A-F]{6}$/.test(color) ? color : DEFAULT_PROFILE_COLOR;
  }

  function contrastTextColor(value) {
    const color = normalizeProfileColor(value).slice(1);
    const channels = [0, 2, 4].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
    const luminance = channels
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
    return luminance > 0.179 ? "#111111" : "#FFFFFF";
  }

  function profileColor() {
    return normalizeProfileColor(state.userColor);
  }

  function loadChatPosition() {
    try {
      const value = JSON.parse(localStorage.getItem("vanta.chatPosition") || "null");
      if (value?.version === CHAT_POSITION_VERSION
        && Number.isFinite(value?.x) && Number.isFinite(value?.y)) {
        return { x: Math.max(0, Math.min(1, value.x)), y: Math.max(0, Math.min(1, value.y)) };
      }
    } catch (_) {}
    return null;
  }

  function applyChatPosition(panel) {
    if (panel.hidden || panel.getBoundingClientRect().width < 1) {
      panel.dataset.positionPending = "1";
      return;
    }
    panel.dataset.positionPending = "0";
    const position = state.chatPosition || loadChatPosition();
    state.chatPosition = position;
    if (!position) {
      panel.dataset.positioned = "0";
      panel.style.left = "22px";
      panel.style.right = "auto";
      panel.style.top = "auto";
      panel.style.bottom = "22px";
      return;
    }
    const rect = panel.getBoundingClientRect();
    const availableLeft = Math.max(0, innerWidth - rect.width - 16);
    const availableTop = Math.max(0, innerHeight - rect.height - 16);
    panel.dataset.positioned = "1";
    panel.style.left = `${8 + position.x * availableLeft}px`;
    panel.style.top = `${8 + position.y * availableTop}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function saveChatPosition(panel) {
    const rect = panel.getBoundingClientRect();
    const availableLeft = Math.max(1, innerWidth - rect.width - 16);
    const availableTop = Math.max(1, innerHeight - rect.height - 16);
    state.chatPosition = {
      version: CHAT_POSITION_VERSION,
      x: Math.max(0, Math.min(1, (rect.left - 8) / availableLeft)),
      y: Math.max(0, Math.min(1, (rect.top - 8) / availableTop)),
    };
    localStorage.setItem("vanta.chatPosition", JSON.stringify(state.chatPosition));
  }

  function replaceChatList(list, nodes) {
    const panel = list.closest("#vanta-chat");
    const anchoredBottom = panel?.dataset.positioned === "1" && !state.chatDragging
      ? panel.getBoundingClientRect().bottom
      : null;
    list.replaceChildren(...nodes);
    if (panel && anchoredBottom !== null) {
      const rect = panel.getBoundingClientRect();
      const top = Math.max(8, Math.min(innerHeight - rect.height - 8, anchoredBottom - rect.height));
      panel.style.top = `${top}px`;
      saveChatPosition(panel);
    }
    window.requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
    });
  }

  function resetChatPosition(panel) {
    state.chatPosition = null;
    localStorage.removeItem("vanta.chatPosition");
    applyChatPosition(panel);
  }

  function makeChatDraggable(panel, handle) {
    let drag = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
      state.chatDragging = true;
      panel.dataset.dragging = "1";
      panel.dataset.positioned = "1";
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const rect = panel.getBoundingClientRect();
      const left = Math.max(8, Math.min(innerWidth - rect.width - 8, event.clientX - drag.offsetX));
      const top = Math.max(8, Math.min(innerHeight - rect.height - 8, event.clientY - drag.offsetY));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    });
    const finish = (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      saveChatPosition(panel);
      state.chatDragging = false;
      panel.dataset.dragging = "0";
      drag = null;
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("dblclick", () => {
      resetChatPosition(panel);
    });
  }

  function createChatPanel() {
    const panel = document.createElement("section");
    panel.id = "vanta-chat";
    panel.hidden = !state.chatOpen;
    panel.dataset.open = state.chatOpen ? "1" : "0";
    panel.dataset.positioned = "0";
    panel.dataset.dragging = "0";
    panel.dataset.minimized = state.chatMinimized ? "1" : "0";
    panel.setAttribute("aria-label", "VANTA 채팅");
    const header = document.createElement("div");
    header.className = "vanta-chat-header";
    header.title = "드래그해서 이동 · 두 번 클릭해서 위치 초기화";
    const headerTitle = document.createElement("span");
    headerTitle.className = "vanta-chat-title";
    headerTitle.textContent = "채팅";
    const windowControls = document.createElement("div");
    windowControls.className = "vanta-chat-window-controls";
    const minimize = iconButton("최소화", "minimize", "vanta-chat-window-button vanta-chat-minimize");
    const resetPosition = iconButton("위치 초기화", "refresh", "vanta-chat-window-button");
    const close = iconButton("닫기", "close", "vanta-chat-window-button vanta-chat-close");
    for (const button of [minimize, resetPosition, close]) {
      button.addEventListener("pointerdown", (event) => event.stopPropagation());
      button.addEventListener("click", (event) => event.stopPropagation());
      button.addEventListener("dblclick", (event) => event.stopPropagation());
    }
    minimize.addEventListener("click", () => {
      state.chatMinimized = !state.chatMinimized;
      panel.dataset.minimized = state.chatMinimized ? "1" : "0";
      setButtonIcon(minimize, state.chatMinimized ? "maximize" : "minimize");
      minimize.setAttribute("aria-label", state.chatMinimized ? "복원" : "최소화");
      minimize.title = state.chatMinimized ? "복원" : "최소화";
      if (!state.chatMinimized) {
        window.requestAnimationFrame(() => {
          list.scrollTop = list.scrollHeight;
        });
      }
    });
    resetPosition.addEventListener("click", () => resetChatPosition(panel));
    close.addEventListener("click", () => {
      state.chatMinimized = false;
      panel.dataset.minimized = "0";
      setButtonIcon(minimize, "minimize");
      state.chatOpen = false;
      renderChat();
    });
    windowControls.append(minimize, resetPosition, close);
    header.append(headerTitle, windowControls);
    const list = document.createElement("div");
    list.className = "vanta-chat-list";
    list.dataset.vantaChatList = "1";
    list.setAttribute("aria-live", "polite");
    const empty = document.createElement("span");
    empty.className = "vanta-chat-empty";
    empty.dataset.vantaChatEmpty = "1";
    empty.textContent = "대화를 시작해 보세요";
    list.append(empty);
    const form = document.createElement("form");
    form.className = "vanta-chat-form";
    const textarea = document.createElement("textarea");
    textarea.rows = 1;
    textarea.maxLength = CHAT_MAX_LENGTH;
    textarea.placeholder = "메시지";
    textarea.setAttribute("aria-label", "채팅 메시지");
    const count = document.createElement("span");
    count.className = "vanta-chat-count";
    count.dataset.vantaChatCount = "1";
    count.hidden = true;
    const send = document.createElement("button");
    send.type = "submit";
    send.className = "vanta-chat-send";
    send.setAttribute("aria-label", "전송");
    send.title = "전송";
    setElementIcon(send, "send");
    textarea.addEventListener("input", () => {
      const length = Array.from(textarea.value).length;
      count.textContent = `${length}/${CHAT_MAX_LENGTH}`;
      count.hidden = length < 80;
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      sendChatMessage(textarea, send);
    });
    form.append(textarea, count, send);
    panel.append(header, list, form);
    makeChatDraggable(panel, header);
    if (!panel.hidden) window.requestAnimationFrame(() => applyChatPosition(panel));
    else panel.dataset.positionPending = "1";
    return panel;
  }

  function toggleChat(force) {
    if (!state.connected) return;
    state.chatOpen = typeof force === "boolean" ? force : !state.chatOpen;
    if (state.chatOpen) state.chatUnread = false;
    renderChat();
    if (state.chatOpen) window.setTimeout(() => document.querySelector("#vanta-chat textarea")?.focus(), 220);
  }

  function renderChat() {
    const panel = document.getElementById("vanta-chat");
    if (!panel) return;
    const shouldOpen = state.chatOpen && state.connected;
    if (shouldOpen) {
      window.clearTimeout(state.chatCloseTimer);
      state.chatCloseTimer = 0;
      if (panel.hidden) {
        panel.dataset.open = "0";
        panel.hidden = false;
        window.requestAnimationFrame(() => {
          if (panel.dataset.positionPending === "1") applyChatPosition(panel);
          if (state.chatOpen && state.connected) panel.dataset.open = "1";
        });
      } else {
        panel.dataset.open = "1";
      }
    } else {
      panel.dataset.open = "0";
      if (!panel.hidden && !state.chatCloseTimer) {
        state.chatCloseTimer = window.setTimeout(() => {
          if (!state.chatOpen || !state.connected) panel.hidden = true;
          state.chatCloseTimer = 0;
        }, 320);
      }
    }
    const toggle = getRoot()?.querySelector("[data-vanta-chat-toggle]");
    if (toggle) {
      toggle.dataset.unread = state.chatUnread ? "1" : "0";
      toggle.dataset.active = state.chatOpen ? "1" : "0";
      toggle.setAttribute("aria-expanded", String(state.chatOpen));
    }
    const list = panel.querySelector("[data-vanta-chat-list]");
    if (!list) return;
    const messages = [...state.chatMessages]
      .sort((left, right) => Number(left.at || 0) - Number(right.at || 0) || String(left.id).localeCompare(String(right.id)))
      .slice(-CHAT_HISTORY_LIMIT);
    if (!messages.length) {
      const empty = document.createElement("span");
      empty.className = "vanta-chat-empty";
      empty.textContent = "대화를 시작해 보세요";
      replaceChatList(list, [empty]);
      return;
    }
    replaceChatList(list, messages.map((message) => {
      const item = document.createElement("div");
      item.className = `vanta-chat-message${message.participantId === state.participantId ? " is-mine" : ""}`;
      if (message.pending) item.classList.add("is-pending");
      const name = document.createElement("span");
      name.className = "vanta-chat-name";
      name.textContent = message.participantId === state.participantId ? "나" : String(message.name || "참여자").slice(0, 20);
      const body = document.createElement("span");
      body.className = "vanta-chat-body";
      body.textContent = String(message.text || "");
      item.append(name, body);
      return item;
    }));
  }

  function receiveChatMessages(messages) {
    const normalized = Array.isArray(messages) ? messages.slice(-CHAT_HISTORY_LIMIT) : [];
    const signature = normalized.map((message) => `${message.id}:${message.at}`).join("|");
    const newest = normalized.at(-1);
    if (state.lastChatSignature && signature !== state.lastChatSignature
      && newest?.participantId !== state.participantId && !state.chatOpen) {
      state.chatUnread = true;
    }
    state.lastChatSignature = signature;
    const pending = state.chatMessages.filter((message) => message?.pending === true);
    const unmatchedPending = pending.filter((local) => !normalized.some((remote) =>
      remote?.participantId === state.participantId
      && remote?.text === local.text
      && Math.abs(Number(remote?.at || 0) - Number(local.at || 0)) < 60000));
    state.chatMessages = [...normalized, ...unmatchedPending]
      .sort((left, right) => Number(left.at || 0) - Number(right.at || 0))
      .slice(-CHAT_HISTORY_LIMIT);
    renderChat();
  }

  async function sendChatMessage(textarea, button) {
    if (state.chatSendInFlight || !state.connected) return;
    const text = String(textarea.value || "").replace(/\r\n?/g, "\n").trim();
    if (!text || Array.from(text).length > CHAT_MAX_LENGTH || text.split("\n").length > 3) return;
    const optimisticId = `pending-${randomToken(8)}`;
    const optimisticMessage = {
      id: optimisticId,
      participantId: state.participantId,
      name: getDisplayName() || "익명",
      text,
      at: Date.now(),
      pending: true,
    };
    state.chatMessages = [...state.chatMessages, optimisticMessage]
      .sort((left, right) => Number(left.at || 0) - Number(right.at || 0))
      .slice(-CHAT_HISTORY_LIMIT);
    textarea.value = "";
    textarea.dispatchEvent(new Event("input"));
    renderChat();
    state.chatSendInFlight = true;
    button.disabled = true;
    try {
      const result = await sendRuntimeMessage({
        type: "VANTA_SEND_CHAT",
        token: state.token,
        participantId: state.participantId,
        text,
      });
      const stored = result?.message;
      state.chatMessages = state.chatMessages
        .filter((message) => message.id !== optimisticId && (!stored?.id || message.id !== stored.id))
        .concat(stored && typeof stored === "object" ? stored : optimisticMessage)
        .sort((left, right) => Number(left.at || 0) - Number(right.at || 0))
        .slice(-CHAT_HISTORY_LIMIT);
      renderChat();
    } catch (error) {
      state.chatMessages = state.chatMessages.filter((message) => message.id !== optimisticId);
      if (!textarea.value) {
        textarea.value = text;
        textarea.dispatchEvent(new Event("input"));
      }
      renderChat();
      setStatus(shortErrorMessage(error, "채팅 전송 실패"), "warning");
    } finally {
      state.chatSendInFlight = false;
      button.disabled = false;
      textarea.focus();
    }
  }

  function startRealtimeStream() {
    window.clearTimeout(state.streamReconnectTimer);
    state.streamReconnectTimer = 0;
    const port = chrome.runtime.connect({ name: "vanta-realtime" });
    state.streamPort = port;
    port.onMessage.addListener((message) => {
      if (message?.type === "PARTICIPANTS") {
        state.participants = Array.isArray(message.participants) ? message.participants : [];
        updateParticipantDisplay();
      }
      if (message?.type === "CHAT") receiveChatMessages(message.messages);
      if (message?.type === "CURSORS") receiveRemoteCursors(message.cursors);
      if (message?.type === "LIVE_CURSOR_UNAVAILABLE") {
        disableLiveCursorAfterFailure(new Error(message.error || "Live 커서 연결이 끊겼습니다."));
      }
      if (message?.type === "ROOM_SETTINGS") {
        state.maxParticipants = Math.max(2, Math.min(5, Number(message.maxParticipants || state.maxParticipants)));
        applyLiveCursorTransport(message.liveCursor === true);
        updateParticipantDisplay();
        updateSettingsDisplay();
      }
      if (message?.type === "PROJECT_DELTA") enqueueProjectChange(message.change);
      if (message?.type === "PROJECT_GAP") pollRemoteSession(message.revision);
      if (message?.type === "STREAM_READY") state.streamReconnectBackoffMs = 1000;
    });
    port.onDisconnect.addListener(() => {
      if (!state.connected || state.streamPort !== port) return;
      state.streamPort = null;
      const delay = state.streamReconnectBackoffMs;
      state.streamReconnectBackoffMs = Math.min(30000, Math.max(1000, delay * 2));
      state.streamReconnectTimer = window.setTimeout(startRealtimeStream, delay);
    });
    port.postMessage({
      type: "SUBSCRIBE",
      token: state.token,
      participantId: state.participantId,
      syncVersion: state.syncVersion,
      liveCursorMode: state.liveCursorMode,
    });
  }

  async function exportAndStoreIfChanged(force = false) {
    if (!state.connected || state.applyingRemote || state.syncInFlight || state.stopped || !isVantaWorkspace()) return;
    if (state.editSequence === state.syncedEditSequence) {
      state.unsyncedSinceAt = 0;
      return;
    }
    if (state.editPointerActive) return;
    const now = Date.now();
    const idleFor = now - Number(state.lastEditAt || now);
    const waitingFor = now - Number(state.unsyncedSinceAt || now);
    if (!force && idleFor < PROJECT_SYNC_IDLE_MS && waitingFor < PROJECT_SYNC_MAX_WAIT_MS) return;
    const epoch = state.connectionEpoch;
    const token = state.token;
    const editSequence = state.editSequence;
    const syncGeneration = ++state.syncGeneration;
    state.syncInFlight = true;
    try {
      const project = await pageRequest("VANTA_EXPORT_PROJECT", null, 5000);
      if (!isCurrentConnection(epoch, token)) return;
      if (project?.__vantaDeferred) {
        setStatus(deferredStatus(project.__vantaDeferred, "local"), "warning");
        return;
      }
      const hash = await sha256(project);
      if (!isCurrentConnection(epoch, token)) return;
      if (hash === state.lastProjectHash) {
        state.syncedEditSequence = Math.max(state.syncedEditSequence, editSequence);
        state.unsyncedSinceAt = state.editSequence > editSequence ? state.lastEditAt : 0;
        setStatus(connectedStatus(), "success");
        return;
      }
      if (!state.projectBundle) throw new Error("VANTA 작품 조각을 다시 불러와야 합니다.");
      const nextBundle = VantaProjectChunks.split(project);
      const delta = VantaProjectChunks.diff(state.projectBundle, nextBundle);
      if (!delta.changedCount) {
        state.lastProjectHash = hash;
        state.syncedEditSequence = Math.max(state.syncedEditSequence, editSequence);
        state.unsyncedSinceAt = state.editSequence > editSequence ? state.lastEditAt : 0;
        setStatus(connectedStatus(), "success");
        return;
      }
      const result = await sendRuntimeMessage({
        type: "VANTA_UPDATE_SESSION",
        token: state.token,
        syncVersion: 2,
        baseRevision: state.revision,
        updatedBy: state.participantId,
        participantCount: state.participantCount,
        delta: { changes: delta.changes, removed: delta.removed },
      });
      if (!isCurrentConnection(epoch, token)) return;
      // The realtime event supplies the authoritative revision. Updating the local
      // bundle now lets another local edit diff against the state we just sent.
      state.projectBundle = nextBundle;
      state.lastProjectHash = hash;
      state.syncedEditSequence = Math.max(state.syncedEditSequence, editSequence);
      state.unsyncedSinceAt = state.editSequence > editSequence ? state.lastEditAt : 0;
      setStatus(result.hadConcurrentUpdate ? "동시 편집" : connectedStatus(), result.hadConcurrentUpdate ? "warning" : "success");
    } catch (error) {
      if (isProjectSizeError(error) && isCurrentConnection(epoch, token)) {
        stopSession(`${shortErrorMessage(error, "용량 초과")}로 Live가 종료됐습니다.`);
        return;
      }
      setStatus(shortErrorMessage(error, "저장 실패"), "error");
    } finally {
      if (state.syncGeneration === syncGeneration) state.syncInFlight = false;
      if (isCurrentConnection(epoch, token) && state.pendingProjectChanges.length) drainProjectChanges();
    }
  }

  async function applyRemoteSession(session) {
    const sessionRevision = Number(session?.revision || 0);
    if (!session?.project || sessionRevision < state.revision
      || (sessionRevision === state.revision && state.projectBundle)) return true;
    if (state.editSequence > state.syncedEditSequence) {
      setStatus("저장 중…", "working");
      return false;
    }
    const epoch = state.connectionEpoch;
    while (state.syncInFlight) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      if (epoch !== state.connectionEpoch || state.stopped || !state.connected) return false;
    }
    // The revision and dirty checks must happen again after waiting. A queued newer
    // reconcile or a user input may have completed in the meantime.
    if (sessionRevision < state.revision
      || (sessionRevision === state.revision && state.projectBundle)) return true;
    if (state.editSequence > state.syncedEditSequence) return false;

    const applySequence = state.editSequence;
    const targetHash = await sha256(session.project);
    if (epoch !== state.connectionEpoch || state.stopped || !state.connected) return false;
    if (state.editSequence !== applySequence) return false;

    const commitRemoteState = () => {
      state.syncVersion = 2;
      state.projectBundle = VantaProjectChunks.clone(session.bundle || VantaProjectChunks.split(session.project));
      state.revision = Number(session.revision || 0);
    };

    // Own SSE acknowledgements often already match the local editor. Commit only the
    // authoritative revision/bundle and avoid a needless clearProject/loadProject.
    if (targetHash === state.lastProjectHash) {
      commitRemoteState();
      state.syncedEditSequence = Math.max(state.syncedEditSequence, applySequence);
      return true;
    }

    const runtimeStatus = await pageRequest("VANTA_RUNTIME_STATUS", null, 1500).catch(() => null);
    if (runtimeStatus?.interfaceEditing) {
      setStatus("편집 후 반영", "working");
      return false;
    }

    window.clearTimeout(state.remoteApplyReleaseTimer);
    state.remoteApplyReleaseTimer = 0;
    const applyGeneration = ++state.remoteApplyGeneration;
    state.applyingRemote = true;
    try {
      if (epoch !== state.connectionEpoch || state.editSequence !== applySequence) return false;
      const imported = await pageRequest("VANTA_IMPORT_PROJECT", { project: session.project, preserveInterface: true }, 15000);
      if (epoch !== state.connectionEpoch || state.stopped || !state.connected) return false;
      if (imported?.applied === false) {
        setStatus(deferredStatus(imported.reason, "remote"), "warning");
        return false;
      }
      commitRemoteState();
      const stable = await captureStableProject();
      if (epoch !== state.connectionEpoch || state.stopped || !state.connected) return false;
      const editedDuringApply = state.editSequence > applySequence;
      // Never mark input that happened while the imported Entry model was settling as
      // synchronized. An empty hash forces the next export to diff it against the
      // authoritative bundle instead of silently accepting the captured local state.
      state.lastProjectHash = editedDuringApply ? "" : stable.hash;
      state.syncedEditSequence = Math.max(state.syncedEditSequence, applySequence);
      state.unsyncedSinceAt = editedDuringApply ? (state.lastEditAt || Date.now()) : 0;
      if (editedDuringApply) scheduleCommandSync();
      setStatus("", "success");
      return true;
    } catch (error) {
      setStatus(shortErrorMessage(error, "동기화 실패"), "error");
      return false;
    } finally {
      window.clearTimeout(state.remoteApplyReleaseTimer);
      state.remoteApplyReleaseTimer = window.setTimeout(() => {
        if (state.remoteApplyGeneration === applyGeneration) state.applyingRemote = false;
        state.remoteApplyReleaseTimer = 0;
      }, 400);
    }
  }

  function enqueueProjectChange(change) {
    if (!change) return;
    const revision = Number(change.revision || 0);
    const changeId = String(change.changeId || "");
    if (!revision || !changeId || revision <= state.revision) return;
    if (change.full === true) {
      requestChunkRecovery(revision);
      return;
    }
    if (state.pendingProjectChanges.some((item) => item.changeId === changeId)) return;
    let changeBytes = 0;
    try { changeBytes = JSON.stringify(change.delta).length; } catch (_) { changeBytes = MAX_PENDING_PROJECT_BYTES + 1; }
    if (state.pendingProjectChanges.length >= MAX_PENDING_PROJECT_CHANGES
      || state.pendingProjectChangeBytes + changeBytes > MAX_PENDING_PROJECT_BYTES) {
      state.pendingProjectChanges = [];
      state.pendingProjectChangeBytes = 0;
      requestChunkRecovery(revision);
      return;
    }
    state.pendingProjectChanges.push({ ...change, revision, changeId, changeBytes });
    state.pendingProjectChangeBytes += changeBytes;
    state.pendingProjectChanges.sort((left, right) => left.revision - right.revision);
    drainProjectChanges();
  }

  function scheduleProjectChangeDrain(delay = 500) {
    if (state.stopped || !state.connected) return;
    window.clearTimeout(state.projectChangeDrainTimer);
    state.projectChangeDrainTimer = window.setTimeout(() => {
      state.projectChangeDrainTimer = 0;
      if (state.pendingRecoveryRevision || state.pendingProjectChanges.length || !state.projectBundle) drainProjectChanges();
    }, delay);
  }

  function requestChunkRecovery(targetRevision = 0) {
    state.pendingRecoveryRevision = Math.max(state.pendingRecoveryRevision, Number(targetRevision || 0));
    scheduleProjectChangeDrain(0);
  }

  async function drainProjectChanges() {
    if (state.projectChangeQueueRunning
      || (!state.pendingRecoveryRevision && state.projectBundle && !state.pendingProjectChanges.length)) return;
    if (state.syncInFlight || state.editSequence > state.syncedEditSequence) {
      scheduleProjectChangeDrain();
      return;
    }
    if (state.pendingRecoveryRevision && !state.pendingRecoverySession && state.lastFullRecoveryAt) {
      const recoveryWait = FULL_RECOVERY_MIN_INTERVAL_MS - (Date.now() - state.lastFullRecoveryAt);
      if (recoveryWait > 0) {
        scheduleProjectChangeDrain(recoveryWait);
        return;
      }
    }
    state.projectChangeQueueRunning = true;
    let retry = false;
    try {
      const epoch = state.connectionEpoch;
      if (state.pendingRecoveryRevision || !state.projectBundle) {
        const targetRevision = Math.max(
          state.pendingRecoveryRevision,
          Number(state.pendingProjectChanges.at(-1)?.revision || 0),
        );
        if (!state.pendingRecoverySession
          || Number(state.pendingRecoverySession.revision || 0) < targetRevision) {
          state.lastFullRecoveryAt = Date.now();
          const session = await sendRuntimeMessage({ type: "VANTA_GET_SESSION", token: state.token });
          if (epoch !== state.connectionEpoch || state.stopped || !state.connected) return;
          if (!session?.project || Number(session.syncVersion || 0) !== 2) {
            throw new Error("VANTA 작품 조각을 복구하지 못했습니다.");
          }
          state.pendingRecoverySession = session;
        }
        const recovery = state.pendingRecoverySession;
        const applied = await applyRemoteSession(recovery);
        if (!applied) {
          retry = true;
          return;
        }
        state.pendingRecoveryRevision = Number(recovery.revision || 0) >= state.pendingRecoveryRevision
          ? 0
          : state.pendingRecoveryRevision;
        state.pendingRecoverySession = null;
        state.pendingProjectChanges = state.pendingProjectChanges
          .filter((change) => Number(change.revision || 0) > state.revision);
        state.pendingProjectChangeBytes = state.pendingProjectChanges
          .reduce((total, change) => total + Number(change.changeBytes || 0), 0);
        return;
      }

      let bundle = VantaProjectChunks.clone(state.projectBundle);
      let revision = state.revision;
      let consumed = 0;
      for (const change of state.pendingProjectChanges) {
        if (change.revision <= revision) {
          consumed += 1;
          continue;
        }
        if (change.revision !== revision + 1 || !change.delta) {
          state.pendingRecoveryRevision = Math.max(state.pendingRecoveryRevision, change.revision);
          retry = true;
          return;
        }
        try {
          bundle = VantaProjectChunks.apply(bundle, change.delta);
        } catch (_) {
          state.pendingRecoveryRevision = Math.max(state.pendingRecoveryRevision, change.revision);
          retry = true;
          return;
        }
        revision = change.revision;
        consumed += 1;
      }

      const project = VantaProjectChunks.assemble(bundle);
      const applied = await applyRemoteSession({
        project,
        bundle,
        revision,
        syncVersion: 2,
      });
      if (!applied) {
        retry = true;
        return;
      }
      const removedChanges = state.pendingProjectChanges.splice(0, consumed);
      state.pendingProjectChangeBytes = Math.max(0, state.pendingProjectChangeBytes
        - removedChanges.reduce((total, change) => total + Number(change.changeBytes || 0), 0));
      setStatus(connectedStatus(), "success");
    } catch (error) {
      setStatus(shortErrorMessage(error, "동기화 실패"), "error");
      retry = true;
    } finally {
      state.projectChangeQueueRunning = false;
      if (retry) scheduleProjectChangeDrain(700);
      else if (state.pendingRecoveryRevision || state.pendingProjectChanges.length) scheduleProjectChangeDrain(0);
    }
  }

  function scheduleRemotePollRetry(delay = state.remotePollBackoffMs) {
    if (state.stopped || !state.connected || state.remotePollRetryTimer) return;
    state.remotePollRetryTimer = window.setTimeout(() => {
      state.remotePollRetryTimer = 0;
      pollRemoteSession();
    }, Math.max(0, delay));
  }

  async function pollRemoteSession(announcedRevision = 0) {
    if (!state.connected || !state.token || state.stopped) return;
    const epoch = state.connectionEpoch;
    const token = state.token;
    state.pendingRemoteRevision = Math.max(state.pendingRemoteRevision, Number(announcedRevision || 0));
    if (state.remotePollInFlight) return;
    const pollGeneration = ++state.remotePollGeneration;
    state.remotePollInFlight = true;
    try {
      const revision = state.pendingRemoteRevision || await sendRuntimeMessage({ type: "VANTA_GET_SESSION_REVISION", token: state.token });
      if (!isCurrentConnection(epoch, token)) return;
      state.pendingRemoteRevision = 0;
      if (Number(revision || 0) <= state.revision) return;
      state.remotePollBackoffMs = 700;
      requestChunkRecovery(revision);
      state.remotePollBackoffMs = 700;
    } catch (error) {
      if (!isCurrentConnection(epoch, token)) return;
      setStatus(shortErrorMessage(error, "연결 확인 중…"), "warning");
      scheduleRemotePollRetry();
      state.remotePollBackoffMs = Math.min(10000, Math.round(state.remotePollBackoffMs * 1.8));
    } finally {
      if (state.remotePollGeneration === pollGeneration) state.remotePollInFlight = false;
      if (isCurrentConnection(epoch, token) && state.pendingRemoteRevision > state.revision) {
        scheduleRemotePollRetry(100);
      }
    }
  }

  async function joinSession() {
    const joinEpoch = ++state.connectionEpoch;
    state.stopped = false;
    setBusy(true);
    showRetry(false);
    setStatus("불러오는 중…", "working");
    try {
      const displayName = await waitForDisplayName();
      if (joinEpoch !== state.connectionEpoch) return;
      const live = await sendRuntimeMessage({
        type: "VANTA_ACQUIRE_LIVE",
        token: state.token,
        participantId: state.participantId,
        connectionId: state.connectionId,
        name: displayName,
        color: profileColor(),
      });
      state.liveLeaseAcquired = true;
      if (joinEpoch !== state.connectionEpoch) {
        releaseLive();
        return;
      }
      state.participantCount = Number(live.participantCount || 1);
      state.maxParticipants = Number(live.maxParticipants || 5);
      state.participants = Array.isArray(live.participants) ? live.participants : [];
      if (live.quota) {
        state.quota = live.quota;
        state.quotaError = "";
        updateQuotaDisplay();
      }
      const session = await sendRuntimeMessage({ type: "VANTA_GET_SESSION", token: state.token });
      // Joining already downloaded the authoritative snapshot. Do not treat that
      // initial read as a recovery cooldown: if the first realtime delta reveals a
      // genuine revision gap, repair it immediately instead of waiting tens of
      // seconds. Later repeated recoveries remain rate-limited.
      state.lastFullRecoveryAt = 0;
      if (joinEpoch !== state.connectionEpoch) return;
      if (!session?.project) throw new Error("이 브라우저에 저장된 VANTA 세션이 없습니다.");
      await waitForEntryRecoveryDialog();
      await waitForEntry();
      if (joinEpoch !== state.connectionEpoch) return;
      const imported = await pageRequest("VANTA_IMPORT_PROJECT", { project: session.project, preserveInterface: false }, 15000);
      if (joinEpoch !== state.connectionEpoch) return;
      if (imported?.applied === false) throw new Error("작품 실행을 정지한 뒤 다시 연결해 주세요.");
      if (Number(session.syncVersion || 0) !== 2) throw new Error("지원되지 않는 VANTA Live입니다.");
      state.syncVersion = 2;
      state.projectBundle = VantaProjectChunks.clone(session.bundle || VantaProjectChunks.split(session.project));
      state.revision = Number(session.revision || 1);
      const stable = await captureStableProject();
      if (joinEpoch !== state.connectionEpoch) return;
      state.lastProjectHash = stable.hash;
      state.syncedEditSequence = state.editSequence;
      state.lastEditAt = 0;
      state.unsyncedSinceAt = 0;
      state.connected = true;
      state.stopped = false;
      setBusy(false);
      updateParticipantDisplay();
      setStatus(connectedStatus(), "success");
      if (state.settingsOpen) {
        loadRoomSettings();
        loadSettingsLink();
      }
      startRealtimeStream();
      state.syncTimer = window.setInterval(exportAndStoreIfChanged, SYNC_CHECK_INTERVAL_MS);
      state.remotePollTimer = window.setInterval(pollRemoteSession, REMOTE_POLL_INTERVAL_MS);
      state.routeTimer = window.setInterval(checkRoute, 500);
      state.heartbeatTimer = window.setInterval(heartbeatLive, LIVE_HEARTBEAT_MS);
      state.cursorTimer = window.setInterval(flushCursor, 25);
      state.cursorContextTimer = window.setInterval(refreshCursorContext, CURSOR_CONTEXT_INTERVAL_MS);
      refreshCursorContext();
      flushCursor();
    } catch (error) {
      setStatus(shortErrorMessage(error, "연결 실패"), "error");
      setBusy(false);
      showRetry(true);
      releaseLive({ preserveRoom: true });
    }
  }

  function heartbeatLive() {
    if (!state.liveLeaseAcquired || !state.token) return;
    const epoch = state.connectionEpoch;
    const token = state.token;
    sendRuntimeMessage({
      type: "VANTA_HEARTBEAT_LIVE",
      token: state.token,
      participantId: state.participantId,
      connectionId: state.connectionId,
      name: getDisplayName(),
      color: profileColor(),
    }).then((live) => {
      if (!isCurrentConnection(epoch, token)) return;
      state.participantCount = Number(live.participantCount || state.participantCount);
      state.maxParticipants = Number(live.maxParticipants || state.maxParticipants);
      if (Array.isArray(live.participants)) state.participants = live.participants;
      if (live.quota) {
        state.quota = live.quota;
        state.quotaError = "";
        updateQuotaDisplay();
      }
      updateParticipantDisplay();
    }).catch((error) => {
      if (isCurrentConnection(epoch, token)) stopSession(shortErrorMessage(error, "연결 종료"));
    });
  }

  function releaseLive(options = {}) {
    if (!state.liveLeaseAcquired || !state.token) return;
    state.liveLeaseAcquired = false;
    sendRuntimeMessage({
      type: "VANTA_RELEASE_LIVE",
      token: state.token,
      participantId: state.participantId,
      connectionId: state.connectionId,
      preserveRoom: options.preserveRoom === true,
    }).catch(() => {});
  }

  function checkRoute() {
    if (state.connected && !isVantaWorkspace()) {
      stopSession("공유 종료");
    }
  }

  function stopSession(message) {
    state.connectionEpoch += 1;
    state.connected = false;
    state.stopped = true;
    window.clearInterval(state.syncTimer);
    window.clearInterval(state.routeTimer);
    window.clearInterval(state.heartbeatTimer);
    window.clearInterval(state.remotePollTimer);
    window.clearInterval(state.cursorTimer);
    window.clearInterval(state.cursorContextTimer);
    window.clearTimeout(state.streamReconnectTimer);
    window.clearTimeout(state.commandSyncTimer);
    window.clearTimeout(state.projectChangeDrainTimer);
    window.clearTimeout(state.remotePollRetryTimer);
    window.clearTimeout(state.remoteApplyReleaseTimer);
    window.clearTimeout(state.chatCloseTimer);
    window.clearTimeout(state.liveCursorRetryTimer);
    state.syncTimer = 0;
    state.routeTimer = 0;
    state.heartbeatTimer = 0;
    state.remotePollTimer = 0;
    state.cursorTimer = 0;
    state.cursorContextTimer = 0;
    state.streamReconnectTimer = 0;
    state.commandSyncTimer = 0;
    state.projectChangeDrainTimer = 0;
    state.remotePollRetryTimer = 0;
    state.remoteApplyReleaseTimer = 0;
    state.chatCloseTimer = 0;
    state.liveCursorRetryTimer = 0;
    state.pendingProjectChanges = [];
    state.pendingProjectChangeBytes = 0;
    state.projectChangeQueueRunning = false;
    state.pendingRecoveryRevision = 0;
    state.pendingRecoverySession = null;
    state.pendingRemoteRevision = 0;
    state.applyingRemote = false;
    state.remoteApplyGeneration += 1;
    state.syncInFlight = false;
    state.syncGeneration += 1;
    state.remotePollInFlight = false;
    state.remotePollGeneration += 1;
    state.editPointerActive = false;
    state.blockDragCandidate = null;
    state.localBlockDrag = null;
    state.cursorPoint = { area: "viewport", x: 0.5, y: 0.5, visible: false };
    state.cursorDirty = false;
    state.cursorInFlight = false;
    state.cursorLastRequestAt = 0;
    state.cursorLastWriteAt = 0;
    state.cursorContextInFlight = false;
    state.cursorContext = { sceneKey: "", objectKey: "" };
    clearRemoteCursors();
    state.participants = [];
    state.chatMessages = [];
    state.chatOpen = false;
    state.chatUnread = false;
    state.lastChatSignature = "";
    state.profileDockOpen = false;
    state.settingsOpen = false;
    state.settingsLink = "";
    state.settingsLinkLoading = false;
    state.settingsLinkError = "";
    window.clearTimeout(state.quotaResetFeedbackTimer);
    window.clearTimeout(state.settingsCloseTimer);
    window.cancelAnimationFrame(state.panelWidthFrame);
    state.panelResizeObserver?.disconnect();
    state.panelMutationObserver?.disconnect();
    state.quotaResetFeedbackTimer = 0;
    state.quotaResetComplete = false;
    state.settingsCloseTimer = 0;
    state.panelWidthFrame = 0;
    state.panelTargetWidth = 0;
    state.panelResizeObserver = null;
    state.panelMutationObserver = null;
    state.roomOwner = false;
    state.liveCursorDesired = false;
    state.liveCursorMode = false;
    const streamPort = state.streamPort;
    state.streamPort = null;
    streamPort?.disconnect();
    document.getElementById("vanta-chat")?.setAttribute("hidden", "");
    updateParticipantDisplay();
    releaseLive();
    const base = String(message || "VANTA 연결이 종료되었습니다.").trim();
    setStatus(base.includes(SAVE_WORK_NOTICE) ? base : `${base} ${SAVE_WORK_NOTICE}`, "warning");
  }

  async function init() {
    if (!/^\/ws(?:\/|$)/.test(location.pathname)) return;
    injectRuntime();
    watchEntryRecoveryDialog();
    document.addEventListener("pointerdown", beginPointerEdit, true);
    document.addEventListener("pointermove", continuePointerEdit, true);
    document.addEventListener("pointermove", updateCursorZoneProbe, true);
    document.addEventListener("pointermove", trackLocalCursor, true);
    document.addEventListener("pointerup", endPointerEdit, true);
    document.addEventListener("pointercancel", endPointerEdit, true);
    document.addEventListener("keydown", markUserEdit, true);
    document.addEventListener("input", markUserEdit, true);
    document.addEventListener("change", markUserEdit, true);
    document.addEventListener("mouseout", (event) => {
      if (!event.relatedTarget) hideLocalCursor();
    }, true);
    window.addEventListener("blur", hideLocalCursor);
    window.addEventListener("resize", () => {
      const panel = document.getElementById("vanta-chat");
      if (panel) applyChatPosition(panel);
      updateCursorZoneOverlay();
    });
    await loadUiSettings();
    renderPanel();
    watchHeaderLauncher();
    renderCursorZoneOverlay();
    window.requestAnimationFrame(showTutorial);
    if (isVantaWorkspace()) joinSession();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();

  window.addEventListener("pagehide", () => stopSession("VANTA 연결이 종료되었습니다."), { once: true });
})();
