import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "src", "background.js"), "utf8");
const chunkSource = fs.readFileSync(path.join(here, "..", "src", "project-chunks.js"), "utf8");
const chunkContext = vm.createContext({ TextEncoder, TextDecoder, Uint8Array, atob, btoa, JSON, Object, Array, Map, Set, String, Number, Math, Error });
vm.runInContext(chunkSource, chunkContext);
const projectChunks = chunkContext.VantaProjectChunks;
const TOKEN_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CONNECTION_A = "connection-aaaaaaaa";
const CONNECTION_B = "connection-bbbbbbbb";
const plain = (value) => JSON.parse(JSON.stringify(value));

function makeFirebaseFetch() {
  const database = {};
  const versions = new Map();
  const requests = [];

  function pathParts(url) {
    const pathname = new URL(url).pathname.replace(/^\//, "").replace(/\.json$/, "");
    return pathname ? pathname.split("/").map(decodeURIComponent) : [];
  }

  function read(parts) {
    let node = database;
    for (const part of parts) {
      if (!node || typeof node !== "object" || !(part in node)) return null;
      node = node[part];
    }
    return structuredClone(node);
  }

  function write(parts, value) {
    let node = database;
    for (const part of parts.slice(0, -1)) node = node[part] ||= {};
    if (value === null) delete node[parts.at(-1)];
    else node[parts.at(-1)] = structuredClone(value);
    const key = parts.join("/");
    versions.set(key, Number(versions.get(key) || 0) + 1);
  }

  function applyPatch(parts, changes) {
    for (const [relativePath, rawValue] of Object.entries(changes || {})) {
      const childParts = relativePath.split("/").filter(Boolean);
      const targetParts = [...parts, ...childParts];
      const increment = rawValue?.[".sv"]?.increment;
      const value = Number.isFinite(increment)
        ? Number(read(targetParts) || 0) + Number(increment)
        : rawValue;
      write(targetParts, value);
    }
  }

  function hasInvalidFirebaseKey(value) {
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([key, child]) => /[.#$\[\]\/]/.test(key) || hasInvalidFirebaseKey(child));
  }

  const handler = async (url, options = {}) => {
    requests.push({ url, options: structuredClone(options) });
    if (url === "https://llnk.kr/api/v1/vanta/cursor-access.php") {
      const body = JSON.parse(options.body);
      return response(200, {
        ok: true,
        roomId: body.roomId,
        participantId: body.participantId,
        databaseUrl: "https://vanta-cursor-test.firebasedatabase.app",
        idToken: "test-cursor-id-token",
        expiresAt: Date.now() + 3600000,
        shard: "cursor_test",
      });
    }
    if (url.startsWith("https://vanta-cursor-test.firebasedatabase.app/")) {
      if (options.headers?.Accept === "text/event-stream") {
        return {
          ok: true,
          status: 200,
          body: {
            getReader() {
              return {
                read() {
                  return new Promise((resolve, reject) => {
                    if (options.signal?.aborted) return resolve({ done: true });
                    options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
                  });
                },
              };
            },
          },
          headers: { get: () => null },
          async text() { return ""; },
        };
      }
      return response(["PUT", "DELETE"].includes(options.method) ? 204 : 200, null);
    }
    if (url === "https://llnk.kr/api/v1/shorten.php") {
      const body = JSON.parse(options.body);
      assert.match(body.url, /playentry\.org\/ws\/new/);
      return response(200, { ok: true, success: true, shortUrl: "https://llnk.kr/abc123" });
    }
    if (url === "https://llnk.kr/api/v1/vanta/sessions.php") {
      const body = JSON.parse(options.body);
      assert.equal(options.headers["X-VANTA-Version"], "1.0.29");
      assert.match(body.installationId, /^[A-Za-z0-9_-]{20,128}$/);
      assert.match(body.roomId, /^[A-Za-z0-9_-]{20,128}$/);
      assert.equal(body.protocolVersion, 3);
      if (body.action === "close") {
        const roomParts = ["vanta", "v1", "sessions", body.roomId];
        const room = read(roomParts);
        const activeParticipants = Object.values(room?.participants || {})
          .filter((participant) => Number(participant?.expiresAt || 0) > Date.now());
        if (activeParticipants.length === 0) write(roomParts, null);
        return response(200, {
          ok: true,
          roomId: body.roomId,
          closed: activeParticipants.length === 0,
          participantCount: activeParticipants.length,
        });
      }
      if (body.action === "create") {
        const now = Date.now();
        write(["vanta", "v1", "sessions", body.roomId], {
          meta: {
            version: 1,
            releaseVersion: 54,
            ownerUid: "test-uid",
            createdAt: now,
            maxParticipants: 5,
            liveCursor: true,
          },
          snapshot: {
            revision: 1,
            updatedAt: now,
            updatedBy: body.participantId,
            project: { _vantaInitializing: true },
          },
          participants: {
            0: { uid: "test-uid", participantId: body.participantId, protocolVersion: body.protocolVersion, releaseVersion: 54, joinedAt: now, expiresAt: now + 60000 },
          },
        });
      }
      return response(200, {
        ok: true,
        roomId: body.roomId,
        syncToken: "test-sync-token",
        uid: "test-uid",
        roomAccessExpiresAt: Date.now() + 86400000,
        releaseVersion: 54,
      });
    }
    if (url === "https://llnk.kr/api/v1/vanta/gateway.php") {
      assert.equal(options.headers["X-VANTA-Version"], "1.0.29");
      assert.equal(options.headers.Authorization, "Bearer test-sync-token");
      const body = JSON.parse(options.body);
      const roomParts = ["vanta", "v1", "sessions", body.roomId];
      const room = read(roomParts);
      if (!room) return response(404, { ok: false, error: "not found" });
      if (body.action === "session") {
        return response(200, { ok: true, session: { meta: room.meta, snapshot: room.snapshot } });
      }
      if (body.action === "revision") {
        return response(200, { ok: true, revision: Number(room.snapshot?.revision || 0) });
      }
      if (body.action === "acquire" || body.action === "heartbeat") {
        const now = Date.now();
        const participants = Object.fromEntries(Object.entries(room.participants || {})
          .filter(([, participant]) => Number(participant?.expiresAt || 0) > now));
        let slot = Object.entries(participants)
          .find(([, participant]) => participant.participantId === body.participantId)?.[0];
        if (slot === undefined) slot = ["0", "1", "2", "3", "4"].find((candidate) => !participants[candidate]);
        if (slot === undefined) return response(409, { ok: false, error: "full" });
        participants[slot] = {
          uid: "test-uid",
          participantId: body.participantId,
          protocolVersion: 3,
          releaseVersion: 54,
          name: body.name || "참여자",
          color: body.color || "#7351FF",
          joinedAt: Number(participants[slot]?.joinedAt || now),
          expiresAt: now + 45000,
        };
        write([...roomParts, "participants"], participants);
        return response(200, {
          ok: true,
          slot,
          maxParticipants: Number(room.meta?.maxParticipants || 5),
          participants,
          ownerUid: String(room.meta?.ownerUid || ""),
          expiresAt: now + 45000,
        });
      }
      if (body.action === "release") {
        if (body.slot !== undefined) write([...roomParts, "participants", String(body.slot)], null);
        const participants = read([...roomParts, "participants"]) || {};
        return response(200, { ok: true, released: true, empty: Object.keys(participants).length === 0, participants });
      }
      return response(422, { ok: false, error: "unsupported gateway action" });
    }
    if (url === "https://llnk.kr/api/v1/vanta/sync.php") {
      assert.equal(options.headers["X-VANTA-Version"], "1.0.29");
      assert.equal(options.headers.Authorization, "Bearer test-sync-token");
      const body = JSON.parse(options.body);
      assert.match(body.participantId, /^[A-Za-z0-9_-]{8,64}$/);
      const snapshotParts = ["vanta", "v1", "sessions", body.roomId, "snapshot"];
      const now = Date.now();
      const changeId = `change-${String(requests.length).padStart(16, "0")}`;
      if (body.action === "initialize") {
        const current = read(snapshotParts);
        assert.equal(current.revision, 1);
        write(snapshotParts, {
          syncVersion: 2,
          chunkVersion: body.chunkVersion,
          revision: 2,
          updatedAt: now,
          updatedBy: body.participantId,
          project: JSON.stringify({ _vantaChunked: true }),
          chunks: body.chunks,
          latest: {
            revision: 2,
            changeId,
            baseRevision: 1,
            updatedAt: now,
            updatedBy: body.participantId,
            patch: JSON.stringify({ full: true }),
          },
        });
        return response(200, { ok: true, revision: 2, updatedAt: now, changeId });
      }
      assert.equal(body.action, "update");
      const patch = {
        revision: { ".sv": { increment: 1 } },
        updatedAt: now,
        updatedBy: body.participantId,
        "latest/revision": { ".sv": { increment: 1 } },
        "latest/changeId": changeId,
        "latest/baseRevision": body.baseRevision,
        "latest/updatedAt": now,
        "latest/updatedBy": body.participantId,
        "latest/patch": JSON.stringify({ version: 1, changes: body.delta.changes, removed: body.delta.removed }),
      };
      for (const [key, value] of Object.entries(body.delta?.changes || {})) patch[`chunks/${key}`] = value;
      for (const key of body.delta?.removed || []) patch[`chunks/${key}`] = null;
      applyPatch(snapshotParts, patch);
      return response(200, { ok: true, revision: 0, updatedAt: now, changeId });
    }
    if (url === "https://llnk.kr/api/v1/vanta/chat.php") {
      assert.equal(options.headers["X-VANTA-Version"], "1.0.29");
      assert.equal(options.headers.Authorization, "Bearer test-sync-token");
      const body = JSON.parse(options.body);
      assert.equal(body.syncToken, "test-sync-token");
      assert.ok(Array.from(body.text).length <= 100);
      const roomParts = ["vanta", "v1", "sessions", body.roomId];
      const room = read(roomParts);
      const participant = Object.values(room?.participants || {})
        .find((item) => item.participantId === body.participantId);
      const message = {
        id: `message-${String(requests.length).padStart(16, "0")}`,
        participantId: body.participantId,
        name: participant?.name || "참여자",
        text: body.text,
        at: Date.now(),
      };
      const previous = Object.values(room?.chat?.messages || {});
      write([...roomParts, "chat", "messages"], [...previous, message].slice(-20));
      return response(200, { ok: true, message });
    }
    if (url === "https://llnk.kr/api/v1/vanta/presence.php") {
      assert.equal(options.headers["X-VANTA-Version"], "1.0.29");
      assert.equal(options.headers.Authorization, "Bearer test-sync-token");
      const body = JSON.parse(options.body);
      assert.match(body.participantId, /^[A-Za-z0-9_-]{8,64}$/);
      return response(200, {
        ok: true,
        quota: { usedTokens: 1, limitTokens: 100, remainingTokens: 99, percent: 1 },
      });
    }
    if (url === "https://llnk.kr/api/v1/vanta/quota.php") {
      assert.equal(options.headers["X-VANTA-Version"], "1.0.29");
      const body = JSON.parse(options.body);
      assert.match(body.installationId, /^[A-Za-z0-9_-]{20,128}$/);
      const reset = body.action === "reset";
      return response(200, {
        ok: true,
        quota: {
          period: "week",
          period_label: "이번 주",
          period_unit: "주",
          used_tokens: reset ? 0 : 4.2,
          limit_tokens: 100,
          remaining_tokens: reset ? 100 : 95.8,
          percent: reset ? 0 : 4.2,
          remaining_percent: reset ? 100 : 95.8,
          reset_credits: reset ? 1 : 2,
        },
      });
    }
    if (url === "https://llnk.kr/api/v1/vanta/settings.php") {
      assert.equal(options.headers["X-VANTA-Version"], "1.0.29");
      assert.equal(options.headers.Authorization, "Bearer test-sync-token");
      const body = JSON.parse(options.body);
      const roomParts = ["vanta", "v1", "sessions", body.roomId];
      if (body.action === "update" && Object.hasOwn(body, "maxParticipants")) {
        write([...roomParts, "meta", "maxParticipants"], body.maxParticipants);
      }
      if (body.action === "update" && Object.hasOwn(body, "liveCursor")) {
        write([...roomParts, "meta", "liveCursor"], body.liveCursor === true);
      }
      const room = read(roomParts);
      return response(200, {
        ok: true,
        maxParticipants: Number(room?.meta?.maxParticipants || 5),
        liveCursor: room?.meta?.liveCursor === true,
        isOwner: true,
      });
    }
    if (url.startsWith("https://identitytoolkit.googleapis.com/")) {
      assert.match(url, /accounts:signInWithCustomToken/);
      // Firebase may omit refreshToken/localId in some browser responses. The LLNKKR-signed
      // room response supplies the UID, and the extension can re-authorize when the token expires.
      return response(200, { idToken: "test-id-token", expiresIn: "3600" });
    }
    if (url.startsWith("https://securetoken.googleapis.com/")) {
      return response(200, { id_token: "test-id-token-2", refresh_token: "test-refresh", user_id: "test-uid", expires_in: "3600" });
    }

    const parts = pathParts(url);
    const key = parts.join("/");
    const method = options.method || "GET";
    if (new URL(url).searchParams.get("print") === "silent" && (options.headers?.["If-Match"] || options.headers?.["If-None-Match"])) {
      return response(400, { error: "Mixing print=silent and conditional requests is not supported" });
    }
    if (method === "GET") return response(200, read(parts), `\"${Number(versions.get(key) || 0)}\"`);
    if (method === "PUT") {
      const expected = options.headers?.["If-Match"];
      const actual = `\"${Number(versions.get(key) || 0)}\"`;
      if (expected && expected !== actual) return response(412, read(parts), actual);
      const value = JSON.parse(options.body);
      if (hasInvalidFirebaseKey(value)) {
        return response(400, { error: "Invalid data; key contains a Firebase-forbidden character." });
      }
      write(parts, value);
      return response(200, value, `\"${Number(versions.get(key) || 0)}\"`);
    }
    if (method === "PATCH") {
      applyPatch(parts, JSON.parse(options.body));
      return response(200, read(parts));
    }
    if (method === "DELETE") {
      write(parts, null);
      return response(200, null);
    }
    return response(400, { error: "unsupported" });
  };
  handler.requests = requests;
  return handler;
}

function response(status, payload, etag = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "etag" ? etag : null },
    async text() { return JSON.stringify(payload); },
  };
}

function makeHarness() {
  const values = {};
  let listener = null;
  const fetch = makeFirebaseFetch();
  const chrome = {
    storage: {
      local: {
        async get(key) {
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.map((item) => [item, values[item]]));
        },
        async set(entries) {
          Object.assign(values, structuredClone(entries));
        },
      },
    },
    runtime: {
      getManifest() { return { version: "1.0.29" }; },
      onMessage: {
        addListener(callback) { listener = callback; },
      },
    },
  };
  vm.runInNewContext(`${chunkSource}\n${source}`, {
    chrome,
    fetch,
    crypto,
    URLSearchParams,
    URL,
    AbortController,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    atob,
    setTimeout,
    clearTimeout,
    Date,
    Error,
    Promise,
    Set,
    Map,
    String,
    Number,
    JSON,
    Object,
    Math,
    encodeURIComponent,
    btoa,
    structuredClone,
  });

  async function send(message) {
    return new Promise((resolve) => {
      const asynchronous = listener(message, {}, resolve);
      assert.equal(asynchronous, true);
    });
  }
  return { send, values, fetch };
}

async function create(send, token, updatedBy = "participant-owner", project = { objects: [], scenes: [] }) {
  return send({
    type: "VANTA_CREATE_SESSION",
    session: { token, project, updatedBy },
  });
}

test("LLNKKR 승인과 방 전용 Firebase 인증을 거쳐 세션을 만들고 다시 읽는다", async () => {
  const { send } = makeHarness();
  const created = await create(send, TOKEN_A);
  assert.equal(created.ok, true);
  assert.equal(created.result.revision, 2);

  const fetched = await send({ type: "VANTA_GET_SESSION", token: TOKEN_A });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.result.updatedBy, "participant-owner");
  assert.equal(fetched.result.syncVersion, 2);

  const revision = await send({ type: "VANTA_GET_SESSION_REVISION", token: TOKEN_A });
  assert.equal(revision.ok, true);
  assert.equal(revision.result, 2);
});

test("동시에 저장해도 Firebase revision은 순서대로 증가한다", async () => {
  const { send } = makeHarness();
  const base = {
    objects: [{ id: "object-a", value: 0 }, { id: "object-b", value: 0 }],
    scenes: [],
  };
  await create(send, TOKEN_A, "participant-owner", base);
  const left = structuredClone(base);
  left.objects[0].value = 1;
  const right = structuredClone(base);
  right.objects[1].value = 2;
  const baseBundle = projectChunks.split(base);
  const leftDelta = projectChunks.diff(baseBundle, projectChunks.split(left));
  const rightDelta = projectChunks.diff(baseBundle, projectChunks.split(right));

  const [first, second] = await Promise.all([
    send({ type: "VANTA_UPDATE_SESSION", token: TOKEN_A, syncVersion: 2, baseRevision: 2, updatedBy: "participant-a", delta: leftDelta }),
    send({ type: "VANTA_UPDATE_SESSION", token: TOKEN_A, syncVersion: 2, baseRevision: 2, updatedBy: "participant-b", delta: rightDelta }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const revision = await send({ type: "VANTA_GET_SESSION_REVISION", token: TOKEN_A });
  assert.equal(revision.result, 4);
  const fetched = await send({ type: "VANTA_GET_SESSION", token: TOKEN_A });
  assert.deepEqual(plain(fetched.result.project), {
    objects: [{ id: "object-a", value: 1 }, { id: "object-b", value: 2 }],
    scenes: [],
  });
});

test("변경 저장은 바뀐 조각만 LLNKKR 검증 프록시에 보내고 다시 GET하지 않는다", async () => {
  const { send, fetch } = makeHarness();
  const base = { objects: [{ id: "object-a", value: 0 }], scenes: [] };
  await create(send, TOKEN_A, "participant-owner", base);
  const next = structuredClone(base);
  next.objects[0].value = 1;
  const delta = projectChunks.diff(projectChunks.split(base), projectChunks.split(next));
  const requestStart = fetch.requests.length;

  const result = await send({
    type: "VANTA_UPDATE_SESSION",
    token: TOKEN_A,
    syncVersion: 2,
    baseRevision: 2,
    updatedBy: "participant-owner",
    delta,
  });
  assert.equal(result.ok, true);

  const requests = fetch.requests.slice(requestStart);
  const sync = requests.find((request) => request.url === "https://llnk.kr/api/v1/vanta/sync.php");
  assert.ok(sync);
  const body = JSON.parse(sync.options.body);
  assert.equal(Object.keys(body.delta.changes).length, 1);
  assert.equal("project" in body, false);
  assert.equal(requests.some((request) => new URL(request.url).pathname.endsWith("/snapshot/latest.json")), false);
});

test("큰 작품은 방을 만들기 전에, 큰 fanout 변경은 전송 전에 차단한다", async () => {
  const firstHarness = makeHarness();
  const oversizedProject = {
    objects: [{ id: "large-object", script: "가".repeat(90000) }],
    scenes: [],
  };
  const rejectedCreate = await create(
    firstHarness.send,
    TOKEN_A,
    "participant-owner",
    oversizedProject,
  );
  assert.equal(rejectedCreate.ok, false);
  assert.match(rejectedCreate.error, /256KB/);
  assert.equal(
    firstHarness.fetch.requests.some((request) => request.url.endsWith("/api/v1/vanta/sessions.php")),
    false,
  );

  const secondHarness = makeHarness();
  await create(secondHarness.send, TOKEN_A);
  const requestStart = secondHarness.fetch.requests.length;
  const rejectedUpdate = await secondHarness.send({
    type: "VANTA_UPDATE_SESSION",
    token: TOKEN_A,
    syncVersion: 2,
    baseRevision: 2,
    updatedBy: "participant-owner",
    participantCount: 5,
    delta: {
      changes: { item_large: JSON.stringify({ id: "large", content: "x".repeat(160000) }) },
      removed: [],
    },
  });
  assert.equal(rejectedUpdate.ok, false);
  assert.match(rejectedUpdate.error, /예상 전송량/);
  assert.equal(
    secondHarness.fetch.requests.slice(requestStart)
      .some((request) => request.url.endsWith("/api/v1/vanta/sync.php")),
    false,
  );
});

test("Firebase 금지 문자가 작품 키에 있어도 JSON 문자열로 손실 없이 저장한다", async () => {
  const { send } = makeHarness();
  const project = {
    objects: [],
    scenes: [],
    "table.value": { "#row[0]/$value": "그대로 보존" },
  };

  const created = await send({
    type: "VANTA_CREATE_SESSION",
    session: { token: TOKEN_A, project, updatedBy: "participant-owner" },
  });
  assert.equal(created.ok, true);

  const fetched = await send({ type: "VANTA_GET_SESSION", token: TOKEN_A });
  assert.deepEqual(plain(fetched.result.project), project);
});

test("확장 프로그램 하나에서는 VANTA Live 하나만 연다", async () => {
  const { send } = makeHarness();
  await create(send, TOKEN_A, "participant-a");
  await create(send, TOKEN_B, "participant-b");

  const first = await send({ type: "VANTA_ACQUIRE_LIVE", token: TOKEN_A, participantId: "participant-a", connectionId: CONNECTION_A });
  assert.equal(first.ok, true);
  assert.equal(first.result.maxParticipants, 5);

  const second = await send({ type: "VANTA_ACQUIRE_LIVE", token: TOKEN_B, participantId: "participant-b", connectionId: CONNECTION_B });
  assert.equal(second.ok, false);
  assert.match(second.error, /이미 다른 VANTA Live/);

  const released = await send({ type: "VANTA_RELEASE_LIVE", token: TOKEN_A, participantId: "participant-a", connectionId: CONNECTION_A });
  assert.equal(released.ok, true);
  const afterRelease = await send({ type: "VANTA_ACQUIRE_LIVE", token: TOKEN_B, participantId: "participant-b", connectionId: CONNECTION_B });
  assert.equal(afterRelease.ok, true);
});

test("같은 탭이 새 Live로 이동하면 늦은 종료 요청을 기다리지 않고 안전하게 전환한다", async () => {
  const { send } = makeHarness();
  await create(send, TOKEN_A, "participant-switch");
  await create(send, TOKEN_B, "participant-switch");

  const first = await send({
    type: "VANTA_ACQUIRE_LIVE",
    token: TOKEN_A,
    participantId: "participant-switch",
    connectionId: CONNECTION_A,
  });
  assert.equal(first.ok, true);

  const switched = await send({
    type: "VANTA_ACQUIRE_LIVE",
    token: TOKEN_B,
    participantId: "participant-switch",
    connectionId: CONNECTION_B,
  });
  assert.equal(switched.ok, true);

  const lateRelease = await send({
    type: "VANTA_RELEASE_LIVE",
    token: TOKEN_A,
    participantId: "participant-switch",
    connectionId: CONNECTION_A,
  });
  assert.equal(lateRelease.ok, true);
  const heartbeat = await send({
    type: "VANTA_HEARTBEAT_LIVE",
    token: TOKEN_B,
    participantId: "participant-switch",
    connectionId: CONNECTION_B,
  });
  assert.equal(heartbeat.ok, true);
});

test("마지막 참가자가 나가면 빈 Firebase 방을 정리한다", async () => {
  const { send } = makeHarness();
  await create(send, TOKEN_A, "participant-a");
  await send({ type: "VANTA_ACQUIRE_LIVE", token: TOKEN_A, participantId: "participant-a", connectionId: CONNECTION_A });

  const released = await send({ type: "VANTA_RELEASE_LIVE", token: TOKEN_A, participantId: "participant-a", connectionId: CONNECTION_A });
  assert.equal(released.ok, true);

  const session = await send({ type: "VANTA_GET_SESSION", token: TOKEN_A });
  assert.equal(session.ok, true);
  assert.equal(session.result, null);
});

test("초기 연결 실패로 나가면 빈 방을 보존해 재시도할 수 있다", async () => {
  const { send } = makeHarness();
  await create(send, TOKEN_A, "participant-a");
  await send({ type: "VANTA_ACQUIRE_LIVE", token: TOKEN_A, participantId: "participant-a", connectionId: CONNECTION_A });

  const released = await send({
    type: "VANTA_RELEASE_LIVE",
    token: TOKEN_A,
    participantId: "participant-a",
    connectionId: CONNECTION_A,
    preserveRoom: true,
  });
  assert.equal(released.ok, true);

  const session = await send({ type: "VANTA_GET_SESSION", token: TOKEN_A });
  assert.equal(session.ok, true);
  assert.deepEqual(plain(session.result.project), { objects: [], scenes: [] });
});

test("참여자 닉네임을 presence에 저장하고 채팅은 LLNKKR를 통해 보낸다", async () => {
  const { send, fetch } = makeHarness();
  await create(send, TOKEN_A, "participant-a");
  const joined = await send({
    type: "VANTA_ACQUIRE_LIVE",
    token: TOKEN_A,
    participantId: "participant-a",
    connectionId: CONNECTION_A,
    name: "다크",
    color: "#7351FF",
  });
  assert.equal(joined.ok, true);
  assert.equal(joined.result.participants[0].name, "다크");
  const sent = await send({
    type: "VANTA_SEND_CHAT",
    token: TOKEN_A,
    participantId: "participant-a",
    text: "함수 확인해 줘",
  });
  assert.equal(sent.ok, true);
  const request = fetch.requests.find((item) => item.url.endsWith("/api/v1/vanta/chat.php"));
  assert.equal(JSON.parse(request.options.body).text, "함수 확인해 줘");
});

test("토큰 조회는 현재 IP의 서버 집계 기간과 남은 퍼센트를 반환한다", async () => {
  const { send } = makeHarness();
  const result = await send({ type: "VANTA_GET_QUOTA" });
  assert.equal(result.ok, true);
  assert.equal(result.result.period, "week");
  assert.equal(result.result.periodUnit, "주");
  assert.equal(result.result.remainingPercent, 95.8);
  assert.equal(result.result.resetCredits, 2);
});

test("토큰 초기화 한 회를 사용하면 현재 기간이 100%로 돌아온다", async () => {
  const { send, fetch } = makeHarness();
  const result = await send({ type: "VANTA_USE_QUOTA_RESET" });
  assert.equal(result.ok, true);
  assert.equal(result.result.remainingPercent, 100);
  assert.equal(result.result.resetCredits, 1);
  const request = fetch.requests.find((item) => item.url.endsWith("/api/v1/vanta/quota.php"));
  assert.equal(JSON.parse(request.options.body).action, "reset");
});

test("방 설정에서 최대 참여 인원을 2~5명으로 바꾼다", async () => {
  const { send, fetch } = makeHarness();
  await create(send, TOKEN_A);
  const live = await send({
    type: "VANTA_ACQUIRE_LIVE",
    token: TOKEN_A,
    participantId: "participant-owner",
    connectionId: CONNECTION_A,
    name: "소유자",
  });
  assert.equal(live.ok, true);
  const current = await send({ type: "VANTA_GET_ROOM_SETTINGS", token: TOKEN_A, participantId: "participant-owner" });
  assert.equal(current.result.isOwner, true);
  assert.equal(current.result.maxParticipants, 5);
  assert.equal(current.result.liveCursor, true);
  const updated = await send({
    type: "VANTA_UPDATE_ROOM_SETTINGS",
    token: TOKEN_A,
    participantId: "participant-owner",
    connectionId: CONNECTION_A,
    maxParticipants: 3,
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.result.maxParticipants, 3);
  const maxRequest = fetch.requests.filter((item) => item.url.endsWith("/api/v1/vanta/settings.php")).at(-1);
  const maxBody = JSON.parse(maxRequest.options.body);
  assert.equal(maxBody.maxParticipants, 3);
  assert.equal(Object.hasOwn(maxBody, "liveCursor"), false);
  const liveUpdated = await send({
    type: "VANTA_UPDATE_ROOM_SETTINGS",
    token: TOKEN_A,
    participantId: "participant-owner",
    connectionId: CONNECTION_A,
    liveCursor: false,
  });
  assert.equal(liveUpdated.ok, true);
  assert.equal(liveUpdated.result.liveCursor, false);
  const liveRequest = fetch.requests.filter((item) => item.url.endsWith("/api/v1/vanta/settings.php")).at(-1);
  assert.equal(JSON.parse(liveRequest.options.body).liveCursor, false);
});

test("새 페이지 연결 뒤 늦게 도착한 이전 페이지 release를 무시한다", async () => {
  const { send } = makeHarness();
  await create(send, TOKEN_A, "participant-a");
  const first = await send({
    type: "VANTA_ACQUIRE_LIVE",
    token: TOKEN_A,
    participantId: "participant-a",
    connectionId: CONNECTION_A,
  });
  assert.equal(first.ok, true);
  const replacement = await send({
    type: "VANTA_ACQUIRE_LIVE",
    token: TOKEN_A,
    participantId: "participant-a",
    connectionId: CONNECTION_B,
  });
  assert.equal(replacement.ok, true);
  const staleRelease = await send({
    type: "VANTA_RELEASE_LIVE",
    token: TOKEN_A,
    participantId: "participant-a",
    connectionId: CONNECTION_A,
  });
  assert.equal(staleRelease.ok, true);
  const heartbeat = await send({
    type: "VANTA_HEARTBEAT_LIVE",
    token: TOKEN_A,
    participantId: "participant-a",
    connectionId: CONNECTION_B,
  });
  assert.equal(heartbeat.ok, true);
});

test("Live 커서 OFF에서는 좌표를 어느 서버에도 보내지 않는다", async () => {
  const { send, fetch } = makeHarness();
  await create(send, TOKEN_A);
  await send({
    type: "VANTA_ACQUIRE_LIVE",
    token: TOKEN_A,
    participantId: "participant-owner",
    connectionId: CONNECTION_A,
    name: "Tester",
  });
  const result = await send({
    type: "VANTA_UPDATE_CURSOR",
    token: TOKEN_A,
    participantId: "participant-owner",
    connectionId: CONNECTION_A,
    seq: 7,
    area: "codeboard",
    x: 0.25,
    y: 0.75,
    color: "#12ABEF",
    visible: true,
    liveCursorMode: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.direct, false);
  assert.equal(fetch.requests.some((item) => item.url.includes("/api/v1/vanta/cursor.php")), false);
  assert.equal(fetch.requests.some((item) => item.url.includes("/api/v1/vanta/cursor-access.php")), false);
  assert.match(source, /message\?\.liveCursorMode !== true/);
  assert.match(source, /ensureLiveCursorAccess\(message\)/);
  assert.match(source, /writeLiveCursor\(access, cursor\)/);
  assert.doesNotMatch(source, /return \{ cursors: \[\], realtime: true, direct: true, quota:/);
});

test("Live 커서는 offscreen 없이 service worker에서 Firebase에 직접 쓴다", async () => {
  const { send, fetch } = makeHarness();
  await create(send, TOKEN_A);
  await send({
    type: "VANTA_ACQUIRE_LIVE",
    token: TOKEN_A,
    participantId: "participant-owner",
    connectionId: CONNECTION_A,
    name: "Tester",
  });
  const enabled = await send({
    type: "VANTA_SET_LIVE_CURSOR",
    token: TOKEN_A,
    participantId: "participant-owner",
    connectionId: CONNECTION_A,
    enabled: true,
  });
  assert.equal(enabled.ok, true);
  const updated = await send({
    type: "VANTA_UPDATE_CURSOR",
    token: TOKEN_A,
    participantId: "participant-owner",
    connectionId: CONNECTION_A,
    seq: 8,
    name: "Tester",
    area: "codeboard",
    x: 0.4,
    y: 0.6,
    fallbackX: 0.25,
    fallbackY: 0.75,
    dragging: true,
    dragBlockKey: "1a2b3c4d",
    dragOffsetX: 0.2,
    dragOffsetY: 0.3,
    color: "#12ABEF",
    visible: true,
    liveCursorMode: true,
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.result.direct, true);
  const write = fetch.requests.find((item) => item.url.includes("vanta-cursor-test.firebasedatabase.app")
    && item.options.method === "PUT");
  assert.ok(write);
  assert.match(write.url, /\/vanta\/cursors\/aaaaaaaa/);
  assert.deepEqual(JSON.parse(write.options.body).at, { ".sv": "timestamp" });
  assert.equal(JSON.parse(write.options.body).fallbackX, 0.25);
  assert.equal(JSON.parse(write.options.body).fallbackY, 0.75);
  assert.equal(JSON.parse(write.options.body).dragging, true);
  assert.equal(JSON.parse(write.options.body).dragBlockKey, "1a2b3c4d");
  assert.equal(JSON.parse(write.options.body).dragOffsetX, 0.2);
  assert.equal(JSON.parse(write.options.body).dragOffsetY, 0.3);
  await send({
    type: "VANTA_SET_LIVE_CURSOR",
    token: TOKEN_A,
    participantId: "participant-owner",
    connectionId: CONNECTION_A,
    enabled: false,
  });
  assert.equal(fetch.requests.some((item) => item.url.includes("vanta-cursor-test.firebasedatabase.app")
    && item.options.method === "DELETE"), true);
});

test("realtime stream broadcasts room settings through the LLNKKR gateway", () => {
  assert.match(source, /run\("all"/);
  assert.match(source, /channel === "meta"/);
  assert.doesNotMatch(source, /channel === "cursor"/);
  assert.doesNotMatch(source, /run\("participants"|run\("chat"|run\("meta"|run\("cursor"|run\("latest"/);
  assert.match(source, /VANTA_STREAM_API/);
  assert.match(source, /type: "ROOM_SETTINGS"[\s\S]*maxParticipants/);
  assert.match(source, /type: "ROOM_SETTINGS"[\s\S]*liveCursor/);
  assert.match(source, /isOwner: Boolean\(ownerUid\)[\s\S]*participant\.uid/);
  assert.match(source, /channel === "meta"[\s\S]*streamParticipantList\(participants, ownerUid\)/);
  assert.doesNotMatch(source, /cursorMode/);
  assert.match(source, /liveCursor: roomMeta\.liveCursor === true/);
});

test("VANTA 초대 링크를 링클로 단축하고 캐시한다", async () => {
  const { send } = makeHarness();
  const url = `https://playentry.org/ws/new?type=normal&mode=block&lang=ko&vanta=${TOKEN_A}`;
  const first = await send({ type: "VANTA_SHORTEN_LINK", url });
  assert.equal(first.ok, true);
  assert.equal(first.result.shortUrl, "https://llnk.kr/abc123");
  assert.equal(first.result.cached, false);

  const second = await send({ type: "VANTA_SHORTEN_LINK", url });
  assert.equal(second.ok, true);
  assert.equal(second.result.cached, true);
});

test("작품 동기화는 LLNKKR에 유지하고 Live 커서는 service worker가 직접 처리한다", () => {
  assert.doesNotMatch(source, /identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com/);
  assert.doesNotMatch(source, /databaseRequest|readDatabaseStream/);
  assert.match(source, /VANTA_GATEWAY_API/);
  assert.match(source, /VANTA_STREAM_API/);
  assert.match(source, /VANTA_CURSOR_ACCESS_API/);
  assert.match(source, /function startLiveCursorSession\(config\)/);
  assert.match(source, /function runLiveCursorStream\(session, generation\)/);
  assert.match(source, /await new Promise\(\(resolve\) => setTimeout\(resolve, 500\)\)/);
  assert.doesNotMatch(source, /chrome\.offscreen|offscreen\/cursor\.html|VANTA_OFFSCREEN/);
  assert.doesNotMatch(source, /chrome\.permissions\.(request|contains)/);
  assert.doesNotMatch(source, /chrome\.permissions\.contains/);
});
