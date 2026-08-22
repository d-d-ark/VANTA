if (typeof importScripts === "function") importScripts("project-chunks.js");

(() => {
  "use strict";

  const AUTH_KEY = "vanta.firebaseAuth";
  const INSTALLATION_ID_KEY = "vanta.installationId";
  const ACTIVE_LIVE_KEY = "vanta.activeLive";
  const LIVE_LEASE_MS = 45000;
  const AUTH_EXPIRY_MARGIN_MS = 60000;
  const MAX_PARTICIPANTS = 5;
  const PROTOCOL_VERSION = 3;
  const RELEASE_VERSION = 54;
  const SYNC_VERSION = 2;
  const CLIENT_VERSION = chrome.runtime.getManifest?.().version || "0";
  const SHORTENER_API = "https://llnk.kr/api/v1/shorten.php";
  const VANTA_SESSION_API = "https://llnk.kr/api/v1/vanta/sessions.php";
  const VANTA_GATEWAY_API = "https://llnk.kr/api/v1/vanta/gateway.php";
  const VANTA_STREAM_API = "https://llnk.kr/api/v1/vanta/stream.php";
  const VANTA_SYNC_API = "https://llnk.kr/api/v1/vanta/sync.php";
  const VANTA_CHAT_API = "https://llnk.kr/api/v1/vanta/chat.php";
  const VANTA_CURSOR_ACCESS_API = "https://llnk.kr/api/v1/vanta/cursor-access.php";
  const VANTA_PRESENCE_API = "https://llnk.kr/api/v1/vanta/presence.php";
  const VANTA_QUOTA_API = "https://llnk.kr/api/v1/vanta/quota.php";
  const VANTA_SETTINGS_API = "https://llnk.kr/api/v1/vanta/settings.php";
  const SHORT_LINK_PREFIX = "vanta.shortLink.";
  const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
  const MAX_PROJECT_JSON_BYTES = 8 * 1024 * 1024;
  // The proxy has a 1 MiB update envelope in addition to the stricter 256 KiB
  // changed-chunk limit enforced by project-chunks.js.
  const MAX_DELTA_JSON_BYTES = (1024 * 1024) - (16 * 1024);
  const CHAT_MAX_LENGTH = 100;
  const CHAT_HISTORY_LIMIT = 20;
  const PRESENCE_REPORT_MS = 30000;
  const sessionQueues = new Map();
  const presenceReportTimes = new Map();
  const liveCursorAccess = new Map();
  const liveCursorSessions = new Map();
  const liveCursorPorts = new Map();
  let authPromise = null;
  let authPromiseToken = "";
  let liveQueue = Promise.resolve();

  function validateToken(value) {
    const token = String(value || "");
    if (!TOKEN_PATTERN.test(token)) throw new Error("VANTA 링크 코드가 올바르지 않습니다.");
    return token;
  }

  function liveIdentity(message) {
    const token = validateToken(message?.token);
    const participantId = String(message?.participantId || "");
    if (!participantId) throw new Error("VANTA Live 참가자 정보가 없습니다.");
    return { token, participantId };
  }

  function liveConnectionIdentity(message) {
    const identity = liveIdentity(message);
    const connectionId = String(message?.connectionId || "");
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(connectionId)) {
      throw new Error("VANTA Live 연결 식별 정보가 없습니다.");
    }
    return { ...identity, connectionId };
  }

  function displayName(value) {
    const normalized = String(value || "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return Array.from(normalized || "참여자").slice(0, 20).join("");
  }

  function profileColor(value) {
    return /^#[0-9A-Fa-f]{6}$/.test(String(value || "")) ? String(value) : "#7351FF";
  }

  function randomId(byteLength = 18) {
    const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  function encodeProject(project) {
    let encoded;
    try {
      encoded = JSON.stringify(project);
    } catch (_) {
      throw new Error("엔트리 작품 데이터를 저장할 수 없습니다.");
    }
    if (!encoded || new TextEncoder().encode(encoded).byteLength > MAX_PROJECT_JSON_BYTES) {
      throw new Error("VANTA로 공유하기에는 작품 데이터가 너무 큽니다.");
    }
    return encoded;
  }

  function decodeProject(stored) {
    if (typeof stored !== "string") return stored;
    try {
      const project = JSON.parse(stored);
      return project && typeof project === "object" ? project : null;
    } catch (_) {
      return null;
    }
  }

  function projectBundleFromChunks(rawChunks) {
    const bundle = {
      version: VantaProjectChunks.FORMAT_VERSION,
      chunks: rawChunks && typeof rawChunks === "object" ? rawChunks : {},
    };
    VantaProjectChunks.validateBundle(bundle);
    return VantaProjectChunks.clone(bundle);
  }

  function encodeProjectDelta(delta, participantCount = 1) {
    const normalized = VantaProjectChunks.validateDelta(delta);
    const encoded = JSON.stringify({ version: VantaProjectChunks.FORMAT_VERSION, ...normalized });
    const encodedBytes = new TextEncoder().encode(encoded).byteLength;
    if (encodedBytes > MAX_DELTA_JSON_BYTES) {
      throw new Error("VANTA 변경 내용이 너무 큽니다.");
    }
    const recipients = Math.max(1, Math.min(5, Number(participantCount || 1)));
    const estimatedDownloadBytes = Math.ceil((encodedBytes * recipients * 1.5) + (16 * 1024));
    if (estimatedDownloadBytes > VantaProjectChunks.MAX_FANOUT_BYTES) {
      throw new Error("참여자에게 보낼 예상 전송량이 1MB를 넘습니다.");
    }
    return { normalized, encoded };
  }

  function decodeProjectDelta(stored) {
    if (typeof stored !== "string") return null;
    try {
      const decoded = JSON.parse(stored);
      if (decoded?.full === true) return { full: true };
      if (Number(decoded?.version || 0) !== VantaProjectChunks.FORMAT_VERSION) return null;
      return VantaProjectChunks.validateDelta(decoded);
    } catch (_) {
      return null;
    }
  }

  async function getInstallationId() {
    const stored = await chrome.storage.local.get(INSTALLATION_ID_KEY);
    let installationId = String(stored[INSTALLATION_ID_KEY] || "");
    if (!TOKEN_PATTERN.test(installationId)) {
      installationId = randomId();
      await chrome.storage.local.set({ [INSTALLATION_ID_KEY]: installationId });
    }
    return installationId;
  }

  async function readStoredAuth() {
    const stored = await chrome.storage.local.get(AUTH_KEY);
    return stored[AUTH_KEY] || null;
  }

  async function saveAuth(payload, context = {}) {
    const auth = {
      uid: payload.uid || context.uid || null,
      roomToken: context.roomToken || null,
      roomAccessExpiresAt: Number(context.roomAccessExpiresAt || 0),
      participantId: String(context.participantId || ""),
      syncToken: context.syncToken || payload.syncToken || null,
      releaseVersion: Number(context.releaseVersion || 0),
    };
    if (!auth.uid || !auth.roomToken || !auth.syncToken || auth.releaseVersion !== RELEASE_VERSION) {
      throw new Error("VANTA 서버 인증 정보가 누락되었습니다.");
    }
    await chrome.storage.local.set({ [AUTH_KEY]: auth });
    return auth;
  }

  async function parseResponse(response) {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }

  function liveCursorKey(token, participantId) {
    return `${token}|${participantId}`;
  }

  function liveCursorDatabaseUrl(session, own = false) {
    const base = String(session?.databaseUrl || "").replace(/\/+$/, "");
    const participant = own ? `/${encodeURIComponent(session.participantId)}` : "";
    return `${base}/vanta/cursors/${encodeURIComponent(session.roomId)}${participant}.json?auth=${encodeURIComponent(session.idToken)}`;
  }

  function mergeLiveCursorTree(root, eventName, payload) {
    const segments = String(payload?.path || "/").split("/").filter(Boolean);
    if (!segments.length) {
      if (eventName === "patch") return { ...(root || {}), ...(payload?.data || {}) };
      return payload?.data && typeof payload.data === "object" ? payload.data : {};
    }
    const next = root && typeof root === "object" ? { ...root } : {};
    let node = next;
    for (const segment of segments.slice(0, -1)) {
      node[segment] = node[segment] && typeof node[segment] === "object" ? { ...node[segment] } : {};
      node = node[segment];
    }
    const leaf = segments.at(-1);
    if (payload?.data === null) delete node[leaf];
    else if (eventName === "patch") node[leaf] = { ...(node[leaf] || {}), ...(payload?.data || {}) };
    else node[leaf] = payload?.data;
    return next;
  }

  function postLiveCursorTree(session) {
    const key = liveCursorKey(session.roomId, session.participantId);
    const payload = { type: "CURSORS", cursors: streamCursorList(session.tree, session.participantId) };
    for (const port of liveCursorPorts.get(key) || []) {
      try { port.postMessage(payload); } catch (_) {}
    }
  }

  function postLiveCursorUnavailable(session, error) {
    const key = liveCursorKey(session.roomId, session.participantId);
    for (const port of liveCursorPorts.get(key) || []) {
      try { port.postMessage({ type: "LIVE_CURSOR_UNAVAILABLE", error }); } catch (_) {}
    }
  }

  function liveCursorSessionCurrent(session, generation) {
    const key = liveCursorKey(session.roomId, session.participantId);
    return !session.stopped && session.generation === generation && liveCursorSessions.get(key) === session;
  }

  async function runLiveCursorStream(session, generation) {
    while (liveCursorSessionCurrent(session, generation)) {
      const controller = new AbortController();
      session.controller = controller;
      try {
        const response = await fetch(liveCursorDatabaseUrl(session), {
          headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const error = new Error(`Live cursor stream ${response.status}`);
          error.status = response.status;
          throw error;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventName = "message";
        let dataLines = [];
        const dispatch = () => {
          if (!dataLines.length) return;
          const raw = dataLines.join("\n");
          dataLines = [];
          if (eventName === "keep-alive") return;
          session.tree = mergeLiveCursorTree(session.tree, eventName, JSON.parse(raw));
          postLiveCursorTree(session);
          eventName = "message";
        };
        while (liveCursorSessionCurrent(session, generation) && !controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line) dispatch();
            else if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
        }
        if (liveCursorSessionCurrent(session, generation) && !controller.signal.aborted) {
          throw new Error("Live cursor stream ended");
        }
      } catch (error) {
        if (!liveCursorSessionCurrent(session, generation) || controller.signal.aborted) return;
        if ([401, 403].includes(Number(error?.status || 0))) {
          postLiveCursorUnavailable(session, "Live 커서 인증이 만료되었습니다.");
          return;
        }
      } finally {
        if (session.controller === controller) session.controller = null;
      }
      if (liveCursorSessionCurrent(session, generation)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  function startLiveCursorSession(config) {
    const key = liveCursorKey(config.roomId, config.participantId);
    const session = liveCursorSessions.get(key) || { tree: {}, generation: 0, stopped: false, controller: null };
    session.controller?.abort();
    Object.assign(session, config);
    session.stopped = false;
    session.generation += 1;
    liveCursorSessions.set(key, session);
    runLiveCursorStream(session, session.generation).catch(() => {});
    return session;
  }

  async function stopLiveCursorSession(roomId, participantId, removeOwn = true) {
    const key = liveCursorKey(roomId, participantId);
    const session = liveCursorSessions.get(key);
    if (!session) return;
    session.stopped = true;
    session.generation += 1;
    session.controller?.abort();
    liveCursorSessions.delete(key);
    if (removeOwn) {
      try { await fetch(liveCursorDatabaseUrl(session, true), { method: "DELETE", cache: "no-store" }); } catch (_) {}
    }
  }

  async function writeLiveCursor(session, cursor) {
    const response = await fetch(`${liveCursorDatabaseUrl(session, true)}&print=silent`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...cursor, at: { ".sv": "timestamp" } }),
      cache: "no-store",
    });
    if (![200, 204].includes(response.status)) {
      const error = new Error(`Live cursor write ${response.status}`);
      error.status = response.status;
      throw error;
    }
  }

  async function fetchLiveCursorAccess(message, retryAuth = true) {
    const { token, participantId } = liveConnectionIdentity(message);
    const installationId = await getInstallationId();
    const auth = await getAuth(token, false, participantId);
    const response = await fetch(VANTA_CURSOR_ACCESS_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${auth.syncToken}`,
        "Content-Type": "application/json",
        "X-VANTA-Version": CLIENT_VERSION,
      },
      body: JSON.stringify({ roomId: token, installationId, participantId }),
    });
    const result = await parseResponse(response);
    if ((response.status === 401 || response.status === 403) && retryAuth) {
      await getAuth(token, true, participantId);
      return fetchLiveCursorAccess(message, false);
    }
    if (response.status === 429) throw new Error(String(result?.error || "Live 커서 토큰이 부족합니다."));
    if (!response.ok || result?.ok === false) {
      throw new Error(String(result?.error || "Live 커서를 연결할 수 없습니다."));
    }
    const access = result;
    if (access.roomId !== token || access.participantId !== participantId
      || !/^https:\/\/[a-z0-9-]+(?:-default-rtdb)?(?:\.[a-z0-9-]+)?\.firebasedatabase\.app$/i.test(String(access.databaseUrl || ""))
      || !String(access.idToken || "") || Number(access.expiresAt || 0) <= Date.now() + 30000) {
      throw new Error("Live 커서 인증 응답이 올바르지 않습니다.");
    }
    const value = {
      roomId: token,
      participantId,
      connectionId: message.connectionId,
      databaseUrl: String(access.databaseUrl),
      idToken: String(access.idToken),
      expiresAt: Number(access.expiresAt),
      shard: String(access.shard || "cursor_a"),
      quota: access.quota ? normalizeQuota(access.quota) : null,
    };
    liveCursorAccess.set(liveCursorKey(token, participantId), value);
    startLiveCursorSession(value);
    return value;
  }

  async function ensureLiveCursorAccess(message) {
    const { token, participantId } = liveConnectionIdentity(message);
    const key = liveCursorKey(token, participantId);
    const cached = liveCursorAccess.get(key);
    if (cached && cached.connectionId === message.connectionId
      && cached.expiresAt > Date.now() + 60000) return cached;
    return fetchLiveCursorAccess(message);
  }

  async function setLiveCursorMode(message) {
    const { token, participantId } = liveConnectionIdentity(message);
    const enabled = message?.enabled === true;
    const key = liveCursorKey(token, participantId);
    if (!enabled) {
      await stopLiveCursorSession(token, participantId).catch(() => {});
      liveCursorAccess.delete(key);
      return { enabled: false };
    }
    const access = await ensureLiveCursorAccess(message);
    return { enabled: true, shard: access.shard, quota: access.quota || null };
  }

  async function requestRoomAuthorization(action, token, details = {}) {
    token = validateToken(token);
    const installationId = await getInstallationId();
    const response = await fetch(VANTA_SESSION_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VANTA-Version": CLIENT_VERSION,
      },
      body: JSON.stringify({
        action,
        roomId: token,
        installationId,
        protocolVersion: PROTOCOL_VERSION,
        participantId: String(details.participantId || ""),
        ...(action === "create" ? {
          maxParticipants: Math.max(2, Math.min(5, Number(details.maxParticipants || MAX_PARTICIPANTS))),
        } : {}),
      }),
    });
    const payload = await parseResponse(response);
    if (!response.ok || payload?.ok === false) {
      if (response.status === 404) throw new Error("VANTA 세션을 찾을 수 없습니다. 링크를 다시 확인해 주세요.");
      if (response.status === 409) throw new Error("이미 사용 중인 VANTA 링크입니다.");
      if (response.status === 429) throw new Error(String(payload?.error || "VANTA 방 생성 한도에 도달했습니다."));
      throw new Error(String(payload?.error || "VANTA 방 인증 서버에 연결하지 못했습니다."));
    }
    if (payload?.roomId !== token || !payload?.syncToken || !payload?.uid
      || Number(payload?.releaseVersion || 0) !== RELEASE_VERSION) {
      throw new Error("VANTA 최신 버전 인증을 받지 못했습니다.");
    }
    return saveAuth(payload, {
      roomToken: token,
      roomAccessExpiresAt: Number(payload.roomAccessExpiresAt || 0),
      uid: String(payload.uid || ""),
      participantId: String(details.participantId || ""),
      syncToken: payload.syncToken || null,
      releaseVersion: Number(payload.releaseVersion || 0),
    });
  }

  async function requestRoomClose(token) {
    token = validateToken(token);
    const installationId = await getInstallationId();
    const response = await fetch(VANTA_SESSION_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VANTA-Version": CLIENT_VERSION,
      },
      body: JSON.stringify({ action: "close", roomId: token, installationId, protocolVersion: PROTOCOL_VERSION }),
    });
    const payload = await parseResponse(response);
    if (!response.ok || payload?.ok === false) {
      throw new Error(String(payload?.error || "VANTA 빈 방 정리에 실패했습니다."));
    }
    return payload;
  }

  async function reportUsagePresence(action, token, participantId, name = "", force = false) {
    const key = `${token}|${participantId}`;
    const now = Date.now();
    if (action === "heartbeat" && !force && now - Number(presenceReportTimes.get(key) || 0) < PRESENCE_REPORT_MS - 5000) {
      return null;
    }
    const installationId = await getInstallationId();
    const auth = await getAuth(token, false, participantId);
    let response;
    try {
      response = await fetch(VANTA_PRESENCE_API, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${auth.syncToken}`,
          "Content-Type": "application/json",
          "X-VANTA-Version": CLIENT_VERSION,
        },
        body: JSON.stringify({ action, roomId: token, installationId, participantId, name: displayName(name) }),
      });
    } catch (_) {
      return null;
    }
    const payload = await parseResponse(response);
    if (response.status === 429) {
      throw new Error(String(payload?.error || "VANTA 토큰을 모두 사용했습니다."));
    }
    if (!response.ok || payload?.ok === false) return null;
    if (action === "leave") presenceReportTimes.delete(key);
    else presenceReportTimes.set(key, now);
    return payload;
  }

  function normalizeQuota(value) {
    const quota = value?.quota || value || {};
    const period = ["day", "week", "month"].includes(String(quota.period || "")) ? String(quota.period) : "week";
    const usedPercent = Math.max(0, Math.min(100, Number(quota.percent ?? quota.usedPercent ?? 0) || 0));
    const remainingPercent = Math.max(0, Math.min(100, Number(quota.remaining_percent ?? quota.remainingPercent ?? (100 - usedPercent)) || 0));
    return {
      period,
      periodLabel: String(quota.period_label ?? quota.periodLabel ?? (period === "day" ? "오늘" : period === "month" ? "이번 달" : "이번 주")),
      periodUnit: String(quota.period_unit ?? quota.periodUnit ?? (period === "day" ? "일" : period === "month" ? "월" : "주")),
      usedTokens: Math.max(0, Number(quota.used_tokens ?? quota.usedTokens ?? 0) || 0),
      limitTokens: Math.max(0, Number(quota.limit_tokens ?? quota.limitTokens ?? 0) || 0),
      remainingTokens: Math.max(0, Number(quota.remaining_tokens ?? quota.remainingTokens ?? 0) || 0),
      usedPercent,
      remainingPercent,
      resetCredits: Math.max(0, Math.floor(Number(quota.reset_credits ?? quota.resetCredits ?? 0) || 0)),
      resetAt: String(quota.reset_at ?? quota.resetAt ?? ""),
      paused: Boolean(quota.paused),
    };
  }

  async function getQuota() {
    const installationId = await getInstallationId();
    const response = await fetch(VANTA_QUOTA_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VANTA-Version": CLIENT_VERSION,
      },
      body: JSON.stringify({ installationId }),
    });
    const payload = await parseResponse(response);
    if (!response.ok || payload?.ok === false) {
      throw new Error(String(payload?.error || "토큰을 확인하지 못했습니다."));
    }
    return normalizeQuota(payload);
  }

  async function useQuotaReset() {
    const installationId = await getInstallationId();
    const response = await fetch(VANTA_QUOTA_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VANTA-Version": CLIENT_VERSION,
      },
      body: JSON.stringify({ installationId, action: "reset" }),
    });
    const payload = await parseResponse(response);
    if (!response.ok || payload?.ok === false) {
      throw new Error(String(payload?.error || "토큰을 초기화하지 못했습니다."));
    }
    return normalizeQuota(payload);
  }

  async function requestRoomSettings(message, update = false, retryAuth = true) {
    const { token, participantId } = liveIdentity(message);
    const installationId = await getInstallationId();
    const auth = await getAuth(token, false, participantId);
    const body = {
      action: update ? "update" : "get",
      roomId: token,
      installationId,
      participantId,
      syncToken: auth.syncToken,
    };
    if (update && Object.prototype.hasOwnProperty.call(message || {}, "maxParticipants")) {
      body.maxParticipants = Math.max(2, Math.min(5, Number(message.maxParticipants || 5)));
    }
    if (update && Object.prototype.hasOwnProperty.call(message || {}, "liveCursor")) {
      body.liveCursor = message.liveCursor === true;
    }
    const response = await fetch(VANTA_SETTINGS_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${auth.syncToken}`,
        "Content-Type": "application/json",
        "X-VANTA-Token": auth.syncToken,
        "X-VANTA-Version": CLIENT_VERSION,
      },
      body: JSON.stringify(body),
    });
    const result = await parseResponse(response);
    if ((response.status === 401 || response.status === 403) && retryAuth) {
      await getAuth(token, true, participantId);
      return requestRoomSettings(message, update, false);
    }
    if (!response.ok || result?.ok === false) {
      throw new Error(String(result?.error || "VANTA 방 설정을 불러오지 못했습니다."));
    }
    return {
      maxParticipants: Math.max(2, Math.min(5, Number(result.maxParticipants || 5))),
      liveCursor: result.liveCursor === true,
      isOwner: result.isOwner === true,
    };
  }

  async function getAuth(token, forceRefresh = false, participantId = "") {
    token = validateToken(token);
    if (authPromise && authPromiseToken === token) return authPromise;
    authPromiseToken = token;
    authPromise = (async () => {
      const stored = await readStoredAuth();
      const sameRoom = stored?.roomToken === token;
      const participantMatches = !participantId || stored?.participantId === participantId;
      const hasRequiredSyncToken = !participantId || Boolean(stored?.syncToken);
      const releaseMatches = Number(stored?.releaseVersion || 0) === RELEASE_VERSION;
      const roomAccessValid = Number(stored?.roomAccessExpiresAt || 0) - AUTH_EXPIRY_MARGIN_MS > Date.now();
      if (!forceRefresh && sameRoom && participantMatches && hasRequiredSyncToken && releaseMatches && roomAccessValid) {
        return stored;
      }
      return requestRoomAuthorization("join", token, {
        participantId: participantId || stored?.participantId || "",
      });
    })();
    try {
      return await authPromise;
    } finally {
      authPromise = null;
      authPromiseToken = "";
    }
  }

  async function requestProjectSync(action, token, participantId, payload = {}) {
    token = validateToken(token);
    participantId = String(participantId || "");
    if (participantId.length < 8 || participantId.length > 64) {
      throw new Error("VANTA Live 참여자 정보가 올바르지 않습니다.");
    }
    let auth = await getAuth(token, false, participantId);
    if (!auth?.syncToken) auth = await getAuth(token, true, participantId);
    if (!auth?.syncToken) throw new Error("VANTA 작품 동기화 권한이 없습니다.");
    const installationId = await getInstallationId();
    const response = await fetch(VANTA_SYNC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${auth.syncToken}`,
        "X-VANTA-Version": CLIENT_VERSION,
      },
      body: JSON.stringify({
        ...payload,
        action,
        roomId: token,
        installationId,
        participantId,
        // Some shared hosts strip Authorization before PHP. Keep the same
        // short-lived room token in the TLS-protected JSON body as a fallback.
        syncToken: auth.syncToken,
      }),
    });
    const result = await parseResponse(response);
    if (!response.ok || result?.ok === false) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("VANTA 작품 동기화 권한이 만료되었습니다.");
      }
      if (response.status === 409) throw new Error("VANTA 작품이 동시에 초기화되었습니다.");
      if (response.status === 413) throw new Error("VANTA 변경 내용이 너무 큽니다.");
      if (response.status === 429) throw new Error("VANTA 변경 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
      throw new Error(String(result?.error || "VANTA 작품을 저장하지 못했습니다."));
    }
    return result;
  }

  async function gatewayRequest(action, token, participantId = "", details = {}, retryAuth = true) {
    token = validateToken(token);
    participantId = String(participantId || "");
    const installationId = await getInstallationId();
    const auth = await getAuth(token, false, participantId);
    const response = await fetch(VANTA_GATEWAY_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${auth.syncToken}`,
        "Content-Type": "application/json",
        "X-VANTA-Version": CLIENT_VERSION,
      },
      body: JSON.stringify({ action, roomId: token, installationId, participantId, ...details }),
    });
    const result = await parseResponse(response);
    if ((response.status === 401 || response.status === 403) && retryAuth) {
      await getAuth(token, true, participantId);
      return gatewayRequest(action, token, participantId, details, false);
    }
    if (!response.ok || result?.ok === false) {
      const error = new Error(String(result?.error || (response.status === 404
        ? "VANTA 세션을 찾을 수 없습니다."
        : response.status === 409
          ? "VANTA Live 연결 정보가 만료되었습니다."
          : response.status === 429
            ? "VANTA 요청이 잠시 제한되었습니다."
            : "VANTA 실시간 서버 요청에 실패했습니다.")));
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function normalizeInviteUrl(value) {
    let url;
    try {
      url = new URL(String(value || ""));
    } catch (_) {
      throw new Error("단축할 VANTA 링크가 올바르지 않습니다.");
    }
    if (url.origin !== "https://playentry.org" || url.pathname !== "/ws/new") {
      throw new Error("VANTA 초대 링크만 단축할 수 있습니다.");
    }
    validateToken(url.searchParams.get("vanta"));
    if (url.href.length > 2048) throw new Error("VANTA 초대 링크가 너무 깁니다.");
    return url;
  }

  function normalizeShortUrl(value) {
    let url;
    try {
      url = new URL(String(value || ""));
    } catch (_) {
      throw new Error("링클 서버가 올바르지 않은 주소를 반환했습니다.");
    }
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "llnk.kr") {
      throw new Error("링클 서버가 올바르지 않은 주소를 반환했습니다.");
    }
    return url.href;
  }

  async function shortenInviteLink(message) {
    const sourceUrl = normalizeInviteUrl(message?.url).href;
    const token = validateToken(new URL(sourceUrl).searchParams.get("vanta"));
    const cacheKey = `${SHORT_LINK_PREFIX}${token}`;
    const saved = await chrome.storage.local.get(cacheKey);
    const cached = saved[cacheKey];
    if (cached?.sourceUrl === sourceUrl) {
      try {
        return { sourceUrl, shortUrl: normalizeShortUrl(cached.shortUrl), cached: true };
      } catch (_) {}
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(SHORTENER_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: sourceUrl }),
        signal: controller.signal,
      });
      const payload = await parseResponse(response);
      if (!response.ok || payload?.ok === false || payload?.success === false) {
        if (response.status === 429) throw new Error("링클 단축 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.");
        throw new Error(String(payload?.error || payload?.message || "링클 단축링크를 만들지 못했습니다."));
      }
      const shortUrl = normalizeShortUrl(payload?.shortUrl || payload?.link?.short_url || payload?.link?.shortUrl);
      await chrome.storage.local.set({ [cacheKey]: { sourceUrl, shortUrl, createdAt: Date.now() } });
      return { sourceUrl, shortUrl, cached: false };
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("링클 서버 응답 시간이 초과되었습니다.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function flattenSession(token, remote) {
    const snapshot = remote?.snapshot;
    if (Number(snapshot?.syncVersion || 0) !== SYNC_VERSION) return null;
    let project;
    let bundle;
    try {
      bundle = projectBundleFromChunks(snapshot?.chunks);
      project = VantaProjectChunks.assemble(bundle);
    } catch (_) {
      return null;
    }
    return {
      version: Number(remote.meta?.version || 1),
      syncVersion: SYNC_VERSION,
      token,
      createdAt: Number(remote.meta?.createdAt || 0),
      updatedAt: Number(snapshot?.updatedAt || 0),
      updatedBy: snapshot?.updatedBy || null,
      revision: Number(snapshot?.revision || 0),
      project,
      bundle,
    };
  }

  async function getSession(token) {
    token = validateToken(token);
    const auth = await getAuth(token);
    let result;
    try {
      result = await gatewayRequest("session", token, auth.participantId);
    } catch (error) {
      if (error?.status === 404) return null;
      throw error;
    }
    if (!result?.session) return null;
    return flattenSession(token, result.session);
  }

  async function getSessionRevision(token) {
    const auth = await getAuth(token);
    const result = await gatewayRequest("revision", token, auth.participantId);
    return Number(result.revision || 0);
  }

  async function createSession(message) {
    const session = message?.session;
    const token = validateToken(session?.token);
    if (!session?.project) throw new Error("세션을 만들 작품 데이터가 없습니다.");
    const participantId = String(session.updatedBy || "");
    if (!participantId) throw new Error("VANTA Live 참가자 정보가 없습니다.");
    // Validate the exact chunk representation before creating the server-side room.
    // An oversized project therefore fails locally without leaving a placeholder.
    const bundle = VantaProjectChunks.split(session.project);
    await requestRoomAuthorization("create", token, {
      participantId,
      maxParticipants: session.maxParticipants,
    });
    return initializeChunkedSession({
      token,
      baseRevision: 1,
      updatedBy: participantId,
      project: session.project,
      bundle,
    });
  }

  async function initializeChunkedSession(message) {
    const token = validateToken(message?.token);
    if (!message?.project) throw new Error("저장할 VANTA 작품 데이터가 없습니다.");
    encodeProject(message.project);
    const bundle = message.bundle
      ? VantaProjectChunks.clone(message.bundle)
      : VantaProjectChunks.split(message.project);
    const result = await requestProjectSync("initialize", token, message.updatedBy, {
      baseRevision: 1,
      syncVersion: SYNC_VERSION,
      chunkVersion: VantaProjectChunks.FORMAT_VERSION,
      chunks: bundle.chunks,
      updatedBy: message.updatedBy,
    });
    return {
      token,
      syncVersion: SYNC_VERSION,
      revision: Number(result.revision || 2),
      updatedAt: Number(result.updatedAt || Date.now()),
      updatedBy: message.updatedBy || null,
      changeId: String(result.changeId || ""),
    };
  }

  async function updateChunkedSession(message) {
    const token = validateToken(message?.token);
    const updatedBy = String(message?.updatedBy || "");
    if (updatedBy.length < 8 || updatedBy.length > 64) throw new Error("VANTA Live 참여자 정보가 올바르지 않습니다.");
    const { normalized } = encodeProjectDelta(message?.delta, message?.participantCount);
    if (!Object.keys(normalized.changes).length && !normalized.removed.length) {
      return { revision: Number(message.baseRevision || 0), changed: false, hadConcurrentUpdate: false };
    }

    const result = await requestProjectSync("update", token, updatedBy, {
      baseRevision: Number(message.baseRevision || 0),
      syncVersion: SYNC_VERSION,
      updatedBy,
      delta: {
        changes: normalized.changes,
        removed: normalized.removed,
      },
    });
    return {
      revision: Number(result.revision || 0),
      changeId: String(result.changeId || ""),
      changed: true,
      confirmed: false,
      // The SSE event is authoritative because another participant may write between
      // this request and any follow-up GET. Avoid downloading the just-uploaded patch.
      hadConcurrentUpdate: false,
    };
  }

  function updateSession(message) {
    return updateChunkedSession(message);
  }

  async function releaseStoredLive(active, closeEmpty = true) {
    const token = validateToken(active?.token);
    const participantId = String(active?.participantId || "");
    const connectionId = String(active?.connectionId || "");
    const released = await gatewayRequest("release", token, participantId, {
      slot: String(active?.slot || ""),
    }).catch(() => null);
    if (closeEmpty && released?.empty === true) {
      await requestRoomClose(token).catch(() => {});
    }
    await stopLiveCursorSession(token, participantId).catch(() => {});
    liveCursorAccess.delete(liveCursorKey(token, participantId));
    await reportUsagePresence("leave", token, participantId).catch(() => {});
    const stored = await chrome.storage.local.get(ACTIVE_LIVE_KEY);
    const current = stored[ACTIVE_LIVE_KEY];
    if (current?.token === token && current?.participantId === participantId
      && current?.connectionId === connectionId) {
      await chrome.storage.local.set({ [ACTIVE_LIVE_KEY]: null });
    }
  }

  async function acquireLiveUnlocked(message) {
    const { token, participantId, connectionId } = liveConnectionIdentity(message);
    const now = Date.now();
    const stored = await chrome.storage.local.get(ACTIVE_LIVE_KEY);
    const active = stored[ACTIVE_LIVE_KEY];
    if (active && Number(active.expiresAt || 0) > now && (active.token !== token || active.participantId !== participantId)) {
      if (active.participantId === participantId) {
        await releaseStoredLive(active);
      } else {
        throw new Error("이 확장 프로그램에서는 이미 다른 VANTA Live가 열려 있습니다.");
      }
    }

    const auth = await getAuth(token, false, participantId);
    const acquired = await gatewayRequest("acquire", token, participantId, {
      name: displayName(message?.name),
      color: profileColor(message?.color),
    });
    const slot = String(acquired.slot ?? "");
    const participants = acquired.participants && typeof acquired.participants === "object" ? acquired.participants : {};
    const maxParticipants = Math.max(2, Math.min(5, Number(acquired.maxParticipants || MAX_PARTICIPANTS)));
    const expiresAt = Number(acquired.expiresAt || now + LIVE_LEASE_MS);
    if (!/^[0-4]$/.test(slot)) throw new Error("VANTA Live 참가자 자리를 받지 못했습니다.");
    await chrome.storage.local.set({
      [ACTIVE_LIVE_KEY]: { token, participantId, connectionId, uid: auth.uid, slot, expiresAt },
    });
    let presence = null;
    try {
      presence = await reportUsagePresence("heartbeat", token, participantId, message?.name, true);
    } catch (error) {
      await gatewayRequest("release", token, participantId, { slot }).catch(() => {});
      await chrome.storage.local.set({ [ACTIVE_LIVE_KEY]: null });
      throw error;
    }
    return {
      participantCount: Object.keys(participants).length,
      maxParticipants,
      participants: streamParticipantList(participants, acquired.ownerUid),
      quota: presence?.quota ? normalizeQuota(presence.quota) : null,
    };
  }

  function acquireLive(message) {
    const next = liveQueue.catch(() => {}).then(() => acquireLiveUnlocked(message));
    liveQueue = next;
    return next;
  }

  async function heartbeatLiveUnlocked(message) {
    const { token, participantId, connectionId } = liveConnectionIdentity(message);
    const stored = await chrome.storage.local.get(ACTIVE_LIVE_KEY);
    const active = stored[ACTIVE_LIVE_KEY];
    if (!active || active.token !== token || active.participantId !== participantId
      || active.connectionId !== connectionId) {
      throw new Error("VANTA Live 연결 정보가 만료되었습니다.");
    }
    if (!/^[0-4]$/.test(String(active.slot))) throw new Error("VANTA Live 참가자 자리가 만료되었습니다.");
    const now = Date.now();
    const heartbeat = await gatewayRequest("heartbeat", token, participantId, {
      slot: String(active.slot),
      name: displayName(message?.name),
      color: profileColor(message?.color),
    });
    const participants = heartbeat.participants && typeof heartbeat.participants === "object" ? heartbeat.participants : {};
    const maxParticipants = Math.max(2, Math.min(5, Number(heartbeat.maxParticipants || MAX_PARTICIPANTS)));
    const expiresAt = Number(heartbeat.expiresAt || now + LIVE_LEASE_MS);
    await chrome.storage.local.set({
      [ACTIVE_LIVE_KEY]: { ...active, slot: String(heartbeat.slot ?? active.slot), expiresAt },
    });
    const presence = await reportUsagePresence("heartbeat", token, participantId, message?.name);
    return {
      participantCount: Object.keys(participants).length,
      maxParticipants,
      participants: streamParticipantList(participants, heartbeat.ownerUid),
      quota: presence?.quota ? normalizeQuota(presence.quota) : null,
    };
  }

  function heartbeatLive(message) {
    const next = liveQueue.catch(() => {}).then(() => heartbeatLiveUnlocked(message));
    liveQueue = next;
    return next;
  }

  async function releaseLiveUnlocked(message) {
    const { token, participantId, connectionId } = liveConnectionIdentity(message);
    const stored = await chrome.storage.local.get(ACTIVE_LIVE_KEY);
    const active = stored[ACTIVE_LIVE_KEY];
    if (!active || active.token !== token || active.participantId !== participantId
      || active.connectionId !== connectionId) return true;
    await releaseStoredLive(active, message?.preserveRoom !== true);
    return true;
  }

  function releaseLive(message) {
    const next = liveQueue.catch(() => {}).then(() => releaseLiveUnlocked(message));
    liveQueue = next;
    return next;
  }

  async function sendChat(message, retryAuth = true) {
    const { token, participantId } = liveIdentity(message);
    const text = String(message?.text || "").replace(/\r\n?/g, "\n").trim();
    if (!text || Array.from(text).length > CHAT_MAX_LENGTH || text.split("\n").length > 3) {
      throw new Error("채팅은 최대 100자, 3줄까지 보낼 수 있습니다.");
    }
    const installationId = await getInstallationId();
    const auth = await getAuth(token, false, participantId);
    const response = await fetch(VANTA_CHAT_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${auth.syncToken}`,
        "Content-Type": "application/json",
        "X-VANTA-Version": CLIENT_VERSION,
      },
      body: JSON.stringify({ roomId: token, installationId, participantId, syncToken: auth.syncToken, text }),
    });
    const result = await parseResponse(response);
    if ((response.status === 401 || response.status === 403) && retryAuth) {
      await getAuth(token, true, participantId);
      return sendChat(message, false);
    }
    if (response.status === 429) throw new Error("채팅을 너무 빠르게 보내고 있습니다. 잠시 후 다시 보내 주세요.");
    if (!response.ok || result?.ok === false) throw new Error(String(result?.error || "채팅을 보내지 못했습니다."));
    return result;
  }

  async function updateCursor(message) {
    const { token, participantId } = liveIdentity(message);
    const dragBlockKey = /^[a-f0-9]{8}$/.test(String(message?.dragBlockKey || ""))
      ? String(message.dragBlockKey)
      : "";
    const dragging = message?.dragging === true && Boolean(dragBlockKey);
    const cursor = {
      participantId,
      connectionId: String(message?.connectionId || "").slice(0, 64),
      seq: Math.max(0, Math.min(2147483647, Number(message?.seq || 0) | 0)),
      name: displayName(message?.name),
      color: profileColor(message?.color),
      area: String(message?.area || "viewport").slice(0, 24),
      sceneKey: String(message?.sceneKey || "").slice(0, 6),
      objectKey: String(message?.objectKey || "").slice(0, 6),
      blockKey: String(message?.blockKey || "").slice(0, 8),
      x: Math.max(0, Math.min(1, Number(message?.x) || 0)),
      y: Math.max(0, Math.min(1, Number(message?.y) || 0)),
      visible: message?.visible === true,
      dragging,
    };
    if (dragging) {
      cursor.dragBlockKey = dragBlockKey;
      cursor.dragOffsetX = Math.max(0, Math.min(1, Number(message?.dragOffsetX) || 0));
      cursor.dragOffsetY = Math.max(0, Math.min(1, Number(message?.dragOffsetY) || 0));
    }
    if (Number.isFinite(Number(message?.fallbackX))) {
      cursor.fallbackX = Math.max(0, Math.min(1, Number(message.fallbackX)));
    }
    if (Number.isFinite(Number(message?.fallbackY))) {
      cursor.fallbackY = Math.max(0, Math.min(1, Number(message.fallbackY)));
    }
    if (message?.liveCursorMode !== true) {
      return { cursors: [], realtime: false, direct: false };
    }
    const key = liveCursorKey(token, participantId);
    let access = await ensureLiveCursorAccess(message);
    try {
      await writeLiveCursor(access, cursor);
    } catch (error) {
      if (![401, 403].includes(Number(error?.status || 0))) throw error;
      liveCursorAccess.delete(key);
      access = await fetchLiveCursorAccess(message);
      await writeLiveCursor(access, cursor);
    }
    return { cursors: [], realtime: true, direct: true };
  }

  function streamDelay(milliseconds, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timeout = setTimeout(resolve, milliseconds);
      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
  }

  function streamRetryAfterMs(response) {
    const raw = String(response?.headers?.get?.("Retry-After") || "").trim();
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(60000, seconds * 1000));
    const retryAt = Date.parse(raw);
    return Number.isFinite(retryAt) ? Math.max(0, Math.min(60000, retryAt - Date.now())) : 0;
  }

  function gatewayStreamError(response, payload, fallback) {
    const error = new Error(String(payload?.error || fallback));
    error.status = Number(response?.status || 0);
    error.retryAfterMs = streamRetryAfterMs(response);
    return error;
  }

  async function readGatewayStream(channel, token, participantId, syncVersion, onEvent, signal) {
    const installationId = await getInstallationId();
    const auth = await getAuth(token, false, participantId);
    const query = new URLSearchParams({
      roomId: token,
      installationId,
      participantId,
      channel,
      syncVersion: String(syncVersion),
    });
    const response = await fetch(`${VANTA_STREAM_API}?${query}`, {
      headers: {
        "Authorization": `Bearer ${auth.syncToken}`,
        "X-VANTA-Token": auth.syncToken,
        "X-VANTA-Version": CLIENT_VERSION,
        "Accept": "text/event-stream",
      },
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      await getAuth(token, true, participantId);
      throw gatewayStreamError(response, null, "VANTA 실시간 스트림 인증을 갱신합니다.");
    }
    if (!response.ok || !response.body) {
      const payload = await parseResponse(response);
      throw gatewayStreamError(response, payload, `VANTA 실시간 스트림 연결 실패 (${response.status})`);
    }

    const openedAt = Date.now();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "message";
    let dataLines = [];
    const dispatch = () => {
      if (!dataLines.length) return;
      const raw = dataLines.join("\n");
      dataLines = [];
      if (eventName === "keep-alive") return;
      if (eventName === "cancel" || eventName === "auth_revoked") throw new Error("VANTA 실시간 스트림이 종료되었습니다.");
      try {
        onEvent(eventName, JSON.parse(raw));
      } catch (error) {
        if (error instanceof SyntaxError) return;
        throw error;
      } finally {
        eventName = "message";
      }
    };

    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line) {
          dispatch();
        } else if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
    return { durationMs: Date.now() - openedAt };
  }

  function updateStreamTree(root, eventName, payload) {
    const segments = String(payload?.path || "/").split("/").filter(Boolean);
    if (!segments.length) {
      if (eventName === "patch") return { ...(root || {}), ...(payload?.data || {}) };
      return payload?.data && typeof payload.data === "object" ? payload.data : {};
    }
    const next = root && typeof root === "object" ? { ...root } : {};
    let node = next;
    for (const segment of segments.slice(0, -1)) {
      node[segment] = node[segment] && typeof node[segment] === "object" ? { ...node[segment] } : {};
      node = node[segment];
    }
    const leaf = segments.at(-1);
    if (payload?.data === null) delete node[leaf];
    else if (eventName === "patch") node[leaf] = { ...(node[leaf] || {}), ...(payload?.data || {}) };
    else node[leaf] = payload?.data;
    return next;
  }

  function streamParticipantList(participants, ownerUid = "") {
    const now = Date.now();
    return Object.values(participants || {})
      .filter((participant) => Number(participant?.expiresAt || 0) > now && participant?.participantId)
      .map((participant) => ({
        id: String(participant.participantId),
        name: displayName(participant.name),
        color: profileColor(participant.color),
        joinedAt: Number(participant.joinedAt || 0),
        isOwner: Boolean(ownerUid) && String(participant.uid || "") === String(ownerUid),
      }))
      .sort((left, right) => left.joinedAt - right.joinedAt || left.id.localeCompare(right.id));
  }

  function streamChatList(messages) {
    return Object.values(messages || {})
      .filter((message) => message && typeof message === "object" && message.id && message.participantId && message.text)
      .map((message) => ({
        id: String(message.id),
        participantId: String(message.participantId),
        name: displayName(message.name),
        text: Array.from(String(message.text)).slice(0, CHAT_MAX_LENGTH).join(""),
        at: Number(message.at || 0),
      }))
      .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
      .slice(-CHAT_HISTORY_LIMIT);
  }

  function streamCursorList(cursors, ownParticipantId) {
    const now = Date.now();
    return Object.values(cursors || {})
      .filter((cursor) => cursor && typeof cursor === "object"
        && cursor.participantId && cursor.participantId !== ownParticipantId
        && cursor.visible === true && Number(cursor.at || 0) >= now - 5000)
      .map((cursor) => {
        const result = {
          participantId: String(cursor.participantId),
          connectionId: String(cursor.connectionId || "").slice(0, 64),
          seq: Math.max(0, Math.min(2147483647, Number(cursor.seq || 0) | 0)),
          name: displayName(cursor.name),
          color: profileColor(cursor.color),
          area: String(cursor.area || "viewport").slice(0, 24),
          sceneKey: String(cursor.sceneKey || "").slice(0, 6),
          objectKey: String(cursor.objectKey || "").slice(0, 6),
          blockKey: String(cursor.blockKey || "").slice(0, 8),
          x: Math.max(0, Math.min(1, Number(cursor.x) || 0)),
          y: Math.max(0, Math.min(1, Number(cursor.y) || 0)),
          at: Number(cursor.at || 0),
          dragging: cursor.dragging === true,
        };
        if (result.dragging && /^[a-f0-9]{8}$/.test(String(cursor.dragBlockKey || ""))) {
          result.dragBlockKey = String(cursor.dragBlockKey);
          result.dragOffsetX = Math.max(0, Math.min(1, Number(cursor.dragOffsetX) || 0));
          result.dragOffsetY = Math.max(0, Math.min(1, Number(cursor.dragOffsetY) || 0));
        }
        if (Number.isFinite(Number(cursor.fallbackX))) {
          result.fallbackX = Math.max(0, Math.min(1, Number(cursor.fallbackX)));
        }
        if (Number.isFinite(Number(cursor.fallbackY))) {
          result.fallbackY = Math.max(0, Math.min(1, Number(cursor.fallbackY)));
        }
        return result;
      })
      .sort((left, right) => right.at - left.at)
      .slice(0, 4);
  }

  function startPortStream(port, message) {
    const { token, participantId } = liveIdentity(message);
    const syncVersion = SYNC_VERSION;
    const directCursor = message?.liveCursorMode === true;
    const liveKey = liveCursorKey(token, participantId);
    const controller = new AbortController();
    let participants = {};
    let chatMessages = {};
    let roomMeta = {};
    let ownerUid = "";
    let latest = {};
    let lastLatestSignature = "";
    let stopped = false;
    const safePost = (payload) => {
      if (stopped) return;
      try { port.postMessage(payload); } catch (_) { stopped = true; controller.abort(); }
    };
    const run = async (channel, onEvent, signal = controller.signal) => {
      let reconnectBackoffMs = 1000;
      while (!stopped && !signal.aborted) {
        let retryAfterMs = 0;
        let healthyConnection = false;
        try {
          const result = await readGatewayStream(channel, token, participantId, syncVersion, onEvent, signal);
          healthyConnection = Number(result?.durationMs || 0) >= 10000;
        } catch (error) {
          retryAfterMs = Math.max(0, Number(error?.retryAfterMs || 0));
          if (!signal.aborted) safePost({
            type: "STREAM_RECONNECTING",
            error: error?.message || "실시간 연결 재시도",
            retryAfterMs,
          });
        }
        if (signal.aborted) break;
        const delayMs = Math.max(healthyConnection ? 1000 : reconnectBackoffMs, retryAfterMs)
          + Math.floor(Math.random() * 250);
        reconnectBackoffMs = healthyConnection
          ? 1000
          : Math.min(30000, Math.max(1000, reconnectBackoffMs * 2));
        await streamDelay(delayMs, signal);
      }
    };
    const emitLatest = () => {
      const revision = Number(latest?.revision || 0);
      const changeId = String(latest?.changeId || "");
      const signature = `${revision}:${changeId}`;
      if (!revision || !changeId || signature === lastLatestSignature) return;
      const delta = decodeProjectDelta(latest?.patch);
      if (!delta) {
        safePost({ type: "PROJECT_GAP", revision });
        return;
      }
      lastLatestSignature = signature;
      safePost({
        type: "PROJECT_DELTA",
        change: {
          revision,
          changeId,
          baseRevision: Number(latest?.baseRevision || 0),
          updatedAt: Number(latest?.updatedAt || 0),
          updatedBy: latest?.updatedBy || null,
          full: delta.full === true,
          delta: delta.full === true ? null : delta,
        },
      });
    };
    run("all", (eventName, envelope) => {
      const channel = String(envelope?.channel || "");
      const payload = envelope?.payload;
      if (!payload || typeof payload !== "object") return;
      if (channel === "participants") {
        participants = updateStreamTree(participants, eventName, payload);
        if (ownerUid) {
          safePost({
            type: "PARTICIPANTS",
            participants: streamParticipantList(participants, ownerUid),
          });
        }
      } else if (channel === "chat") {
        chatMessages = updateStreamTree(chatMessages, eventName, payload);
        safePost({ type: "CHAT", messages: streamChatList(chatMessages) });
      } else if (channel === "meta") {
        roomMeta = updateStreamTree(roomMeta, eventName, payload);
        if (String(roomMeta.ownerUid || "")) ownerUid = String(roomMeta.ownerUid);
        safePost({
          type: "PARTICIPANTS",
          participants: streamParticipantList(participants, ownerUid),
        });
        safePost({
          type: "ROOM_SETTINGS",
          maxParticipants: Math.max(2, Math.min(5, Number(roomMeta.maxParticipants || MAX_PARTICIPANTS))),
          liveCursor: roomMeta.liveCursor === true,
        });
      } else if (channel === "latest") {
        latest = updateStreamTree(latest, eventName, payload);
        // Each Firebase SSE envelope is an ordered, atomic snapshot/patch event.
        // Deferring it through one replaceable timer drops revision N when N+1
        // arrives in the same event-loop turn. Entry often produces consecutive
        // revisions for a single block gesture, so losing N forces every peer into
        // a slow full-project recovery. Forward every completed envelope now and
        // let the content-side revision queue apply them in order.
        emitLatest();
      }
    });
    if (directCursor) {
      const ports = liveCursorPorts.get(liveKey) || new Set();
      ports.add(port);
      liveCursorPorts.set(liveKey, ports);
      const cursorSession = liveCursorSessions.get(liveKey);
      if (cursorSession) safePost({ type: "CURSORS", cursors: streamCursorList(cursorSession.tree, participantId) });
    }
    safePost({ type: "STREAM_READY", participantId });
    return () => {
      stopped = true;
      controller.abort();
      const ports = liveCursorPorts.get(liveKey);
      ports?.delete(port);
      if (ports && ports.size === 0) liveCursorPorts.delete(liveKey);
    };
  }

  function enqueueSessionUpdate(token, task) {
    const queueKey = String(token || "");
    const previous = sessionQueues.get(queueKey) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    sessionQueues.set(queueKey, next);
    const cleanup = () => {
      if (sessionQueues.get(queueKey) === next) sessionQueues.delete(queueKey);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  const MESSAGE_TYPES = new Set([
    "VANTA_CREATE_SESSION",
    "VANTA_GET_SESSION",
    "VANTA_GET_SESSION_REVISION",
    "VANTA_UPDATE_SESSION",
    "VANTA_ACQUIRE_LIVE",
    "VANTA_HEARTBEAT_LIVE",
    "VANTA_RELEASE_LIVE",
    "VANTA_SEND_CHAT",
    "VANTA_UPDATE_CURSOR",
    "VANTA_SET_LIVE_CURSOR",
    "VANTA_GET_QUOTA",
    "VANTA_USE_QUOTA_RESET",
    "VANTA_GET_ROOM_SETTINGS",
    "VANTA_UPDATE_ROOM_SETTINGS",
    "VANTA_SHORTEN_LINK",
  ]);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = message?.type;
    if (!MESSAGE_TYPES.has(type)) return;
    (async () => {
      if (type === "VANTA_CREATE_SESSION") return createSession(message);
      if (type === "VANTA_GET_SESSION") return getSession(message.token);
      if (type === "VANTA_GET_SESSION_REVISION") return getSessionRevision(message.token);
      if (type === "VANTA_UPDATE_SESSION") return enqueueSessionUpdate(message.token, () => updateSession(message));
      if (type === "VANTA_ACQUIRE_LIVE") return acquireLive(message);
      if (type === "VANTA_HEARTBEAT_LIVE") return heartbeatLive(message);
      if (type === "VANTA_RELEASE_LIVE") return releaseLive(message);
      if (type === "VANTA_SEND_CHAT") return sendChat(message);
      if (type === "VANTA_UPDATE_CURSOR") return updateCursor(message);
      if (type === "VANTA_SET_LIVE_CURSOR") return setLiveCursorMode(message);
      if (type === "VANTA_GET_QUOTA") return getQuota();
      if (type === "VANTA_USE_QUOTA_RESET") return useQuotaReset();
      if (type === "VANTA_GET_ROOM_SETTINGS") return requestRoomSettings(message, false);
      if (type === "VANTA_UPDATE_ROOM_SETTINGS") return requestRoomSettings(message, true);
      if (type === "VANTA_SHORTEN_LINK") return shortenInviteLink(message);
      throw new Error("지원하지 않는 VANTA 요청입니다.");
    })()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "VANTA 처리 중 오류가 발생했습니다." }));
    return true;
  });

  chrome.runtime.onConnect?.addListener((port) => {
    if (port.name !== "vanta-realtime") return;
    let stop = null;
    port.onMessage.addListener((message) => {
      if (message?.type !== "SUBSCRIBE") return;
      stop?.();
      try {
        stop = startPortStream(port, message);
      } catch (error) {
        port.postMessage({ type: "STREAM_ERROR", error: error?.message || "실시간 연결을 시작하지 못했습니다." });
      }
    });
    port.onDisconnect.addListener(() => stop?.());
  });
})();
