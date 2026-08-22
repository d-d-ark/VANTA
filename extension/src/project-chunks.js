(() => {
  "use strict";

  if (globalThis.VantaProjectChunks) return;

  const FORMAT_VERSION = 1;
  const MANIFEST_KEY = "manifest";
  const ENTITY_COLLECTIONS = new Set(["objects", "scenes", "variables", "messages", "functions", "tables"]);
  const ID_FIELDS = ["id", "_id", "objectId", "sceneId", "variableId", "messageId", "funcId", "functionId", "tableId"];
  const SAFE_KEY = /^(?:manifest|(?:item|field)_[A-Za-z0-9_-]{1,500})$/;
  // Keep these limits identical to the LLNKKR sync proxy. Checking them before a
  // request prevents a large Entry project from creating an unusable room and
  // prevents an oversized edit from consuming Firebase traffic before it fails.
  const MAX_CHUNKS = 256;
  const MAX_DELTA_CHUNKS = 32;
  const MAX_ENCODED_BYTES = 2 * 1024 * 1024;
  const MAX_CHUNK_BYTES = 256 * 1024;
  const MAX_MANIFEST_BYTES = 128 * 1024;
  const MAX_DELTA_BYTES = 256 * 1024;
  const MAX_MANIFEST_FIELDS = 256;
  const MAX_COLLECTION_ITEMS = 100000;

  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== "object") return value;
    const sorted = Object.create(null);
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
    return sorted;
  }

  function stableStringify(value) {
    return JSON.stringify(canonicalize(value));
  }

  function utf8Bytes(value) {
    return new TextEncoder().encode(String(value)).byteLength;
  }

  function copyStringMap(source) {
    const target = Object.create(null);
    for (const [key, value] of Object.entries(source || {})) target[key] = value;
    return target;
  }

  function encodeKeyPart(value) {
    const bytes = new TextEncoder().encode(String(value));
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function boundedKey(prefix, value) {
    const encoded = `${prefix}_${encodeKeyPart(value)}`;
    if (encoded.length <= 500) return encoded;
    // Entry identifiers are normally short. This deterministic fallback prevents an
    // unexpectedly long user-controlled identifier from exceeding Firebase key limits.
    let hash = 2166136261;
    for (const character of encoded) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `${prefix}_long_${(hash >>> 0).toString(36)}`;
  }

  function decodeKeyPart(value) {
    try {
      const encoded = String(value).replace(/-/g, "+").replace(/_/g, "/");
      const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (_) {
      return null;
    }
  }

  function itemIdentity(item) {
    if (item && typeof item === "object") {
      for (const field of ID_FIELDS) {
        const value = item[field];
        if (["string", "number"].includes(typeof value) && String(value) !== "") return `${field}:${value}`;
      }
    }
    return null;
  }

  function splitCollection(field, value, chunks) {
    const identities = value.map(itemIdentity);
    const unique = new Set(identities);
    if (identities.some((identity) => identity === null) || unique.size !== identities.length) return null;

    const pending = [];
    const keys = identities.map((identity, index) => {
      const key = boundedKey("item", `${field}:${identity}`);
      if (chunks[key] !== undefined || pending.some(([pendingKey]) => pendingKey === key)) return null;
      pending.push([key, stableStringify(value[index])]);
      return key;
    });
    if (keys.some((key) => key === null)) return null;
    for (const [key, encoded] of pending) chunks[key] = encoded;
    return keys;
  }

  function split(project) {
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      throw new Error("VANTA project must be a JSON object.");
    }

    const chunks = Object.create(null);
    const fields = [];
    for (const field of Object.keys(project).sort()) {
      const value = project[field];
      if (ENTITY_COLLECTIONS.has(field) && Array.isArray(value)) {
        const keys = splitCollection(field, value, chunks);
        if (keys) {
          fields.push({ name: field, kind: "items", keys });
        } else {
          // Entry normally gives these collections stable IDs. A malformed or future
          // collection without unique IDs is kept as one chunk so insertion/reordering
          // can never make an index refer to the wrong item.
          const key = boundedKey("field", field);
          chunks[key] = stableStringify(value);
          fields.push({ name: field, kind: "value", key });
        }
      } else {
        const key = boundedKey("field", field);
        chunks[key] = stableStringify(value);
        fields.push({ name: field, kind: "value", key });
      }
    }
    chunks[MANIFEST_KEY] = stableStringify({ version: FORMAT_VERSION, fields });
    return validateBundle({ version: FORMAT_VERSION, chunks });
  }

  function validateBundle(bundle) {
    if (!bundle || Number(bundle.version || 0) !== FORMAT_VERSION || !bundle.chunks || typeof bundle.chunks !== "object") {
      throw new Error("Invalid VANTA project chunk bundle.");
    }
    const entries = Object.entries(bundle.chunks);
    if (!entries.length || entries.length > MAX_CHUNKS) {
      throw new Error("VANTA 작품의 조각 수가 256개를 넘습니다.");
    }
    let encodedBytes = 0;
    for (const [key, value] of entries) {
      if (!SAFE_KEY.test(key) || typeof value !== "string") throw new Error("Invalid VANTA project chunk.");
      const valueBytes = utf8Bytes(value);
      const chunkLimit = key === MANIFEST_KEY ? MAX_MANIFEST_BYTES : MAX_CHUNK_BYTES;
      if (!valueBytes || valueBytes > chunkLimit) {
        throw new Error(key === MANIFEST_KEY
          ? "VANTA 작품 구성이 너무 큽니다."
          : "오브젝트나 함수 한 개가 256KB를 넘습니다.");
      }
      encodedBytes += valueBytes;
      if (encodedBytes > MAX_ENCODED_BYTES) throw new Error("VANTA Live 작품은 최대 2MB까지 사용할 수 있습니다.");
    }
    if (typeof bundle.chunks[MANIFEST_KEY] !== "string") throw new Error("VANTA project manifest is missing.");
    return bundle;
  }

  function assemble(bundle) {
    validateBundle(bundle);
    const manifest = JSON.parse(bundle.chunks[MANIFEST_KEY]);
    if (Number(manifest?.version || 0) !== FORMAT_VERSION || !Array.isArray(manifest.fields)
      || manifest.fields.length > MAX_MANIFEST_FIELDS) {
      throw new Error("Invalid VANTA project manifest.");
    }
    const project = {};
    const fieldNames = new Set();
    const usedChunkKeys = new Set();
    let collectionItems = 0;
    for (const descriptor of manifest.fields) {
      const name = String(descriptor?.name || "");
      if (!name || name.length > 128 || fieldNames.has(name)) throw new Error("Invalid VANTA project field.");
      fieldNames.add(name);
      let value;
      if (descriptor.kind === "items" && Array.isArray(descriptor.keys) && ENTITY_COLLECTIONS.has(name)) {
        collectionItems += descriptor.keys.length;
        if (collectionItems > MAX_COLLECTION_ITEMS) throw new Error("Invalid VANTA project collection size.");
        value = [];
        for (const key of descriptor.keys) {
          if (!SAFE_KEY.test(key) || usedChunkKeys.has(key)) throw new Error(`Invalid VANTA project chunk: ${key}`);
          // A missing referenced chunk is an explicit concurrent deletion. Keep the
          // deletion instead of making an older order manifest resurrect the item.
          if (typeof bundle.chunks[key] !== "string") continue;
          const item = JSON.parse(bundle.chunks[key]);
          const identity = itemIdentity(item);
          if (!identity || boundedKey("item", `${name}:${identity}`) !== key) {
            throw new Error(`Invalid VANTA project item chunk: ${key}`);
          }
          usedChunkKeys.add(key);
          value.push(item);
        }

        // Order/membership is intentionally only a hint. When two participants add
        // different IDs from the same base, the last manifest cannot mention the
        // other new ID. Preserve those valid orphan chunks and append them in a
        // deterministic order; an explicit chunk removal is the only deletion.
        for (const key of Object.keys(bundle.chunks).sort()) {
          if (usedChunkKeys.has(key) || !key.startsWith("item_") || typeof bundle.chunks[key] !== "string") continue;
          const item = JSON.parse(bundle.chunks[key]);
          const identity = itemIdentity(item);
          if (!identity || boundedKey("item", `${name}:${identity}`) !== key) continue;
          collectionItems += 1;
          if (collectionItems > MAX_COLLECTION_ITEMS) throw new Error("Invalid VANTA project collection size.");
          usedChunkKeys.add(key);
          value.push(item);
        }
      } else if (descriptor.kind === "value" && typeof descriptor.key === "string") {
        if (!SAFE_KEY.test(descriptor.key) || usedChunkKeys.has(descriptor.key)
          || boundedKey("field", name) !== descriptor.key) throw new Error(`Invalid VANTA project chunk: ${descriptor.key}`);
        // As with item chunks, a missing value chunk represents an explicit removal
        // that raced with an unrelated manifest update.
        if (typeof bundle.chunks[descriptor.key] !== "string") continue;
        usedChunkKeys.add(descriptor.key);
        value = JSON.parse(bundle.chunks[descriptor.key]);
      } else {
        throw new Error("Invalid VANTA project field descriptor.");
      }
      Object.defineProperty(project, name, { value, enumerable: true, configurable: true, writable: true });
    }

    // Preserve concurrently-added top-level fields whose field chunk arrived with a
    // manifest that lost last-write-wins. Long hashed keys cannot be decoded and are
    // therefore only accepted when explicitly referenced by the manifest.
    for (const key of Object.keys(bundle.chunks).sort()) {
      if (usedChunkKeys.has(key) || !key.startsWith("field_") || key.startsWith("field_long_")) continue;
      const name = decodeKeyPart(key.slice("field_".length));
      if (!name || name.length > 128 || fieldNames.has(name) || boundedKey("field", name) !== key) continue;
      const value = JSON.parse(bundle.chunks[key]);
      fieldNames.add(name);
      usedChunkKeys.add(key);
      Object.defineProperty(project, name, { value, enumerable: true, configurable: true, writable: true });
    }
    return project;
  }

  function diff(previousBundle, nextBundle) {
    validateBundle(nextBundle);
    const previous = previousBundle?.chunks && Number(previousBundle.version || 0) === FORMAT_VERSION
      ? previousBundle.chunks
      : {};
    const changes = Object.create(null);
    const removed = [];
    let bytes = 0;
    for (const [key, value] of Object.entries(nextBundle.chunks)) {
      if (previous[key] === value) continue;
      changes[key] = value;
      bytes += new TextEncoder().encode(key).byteLength + new TextEncoder().encode(value).byteLength;
    }
    for (const key of Object.keys(previous)) {
      if (!(key in nextBundle.chunks)) removed.push(key);
    }
    return { changes, removed, changedCount: Object.keys(changes).length + removed.length, bytes };
  }

  function validateDelta(delta) {
    if (!delta || !delta.changes || typeof delta.changes !== "object" || Array.isArray(delta.changes)) {
      throw new Error("Invalid VANTA project delta.");
    }
    const changes = Object.create(null);
    let changedBytes = 0;
    for (const [key, value] of Object.entries(delta.changes)) {
      if (!SAFE_KEY.test(key) || typeof value !== "string") throw new Error("Invalid VANTA project delta.");
      changes[key] = value;
      const valueBytes = utf8Bytes(value);
      const chunkLimit = key === MANIFEST_KEY ? MAX_MANIFEST_BYTES : MAX_CHUNK_BYTES;
      if (!valueBytes || valueBytes > chunkLimit) {
        throw new Error(key === MANIFEST_KEY
          ? "VANTA 작품 구성이 너무 큽니다."
          : "오브젝트나 함수 한 개가 256KB를 넘습니다.");
      }
      changedBytes += valueBytes;
    }
    const rawRemoved = Array.isArray(delta.removed)
      ? delta.removed
      : Object.keys(delta.removed || {}).filter((key) => delta.removed[key]);
    const removed = [...new Set(rawRemoved)];
    if (Object.keys(changes).length + removed.length > MAX_DELTA_CHUNKS) {
      throw new Error("한 번에 바뀐 작품 조각이 32개를 넘습니다.");
    }
    for (const key of removed) {
      if (!SAFE_KEY.test(key) || key in changes) throw new Error("Invalid VANTA removed chunk key.");
    }
    if (changedBytes > MAX_DELTA_BYTES) throw new Error("한 번의 변경 내용은 최대 256KB까지 보낼 수 있습니다.");
    return { changes, removed };
  }

  function apply(bundle, delta) {
    validateBundle(bundle);
    const normalized = validateDelta(delta);
    const chunks = copyStringMap(bundle.chunks);
    for (const [key, value] of Object.entries(normalized.changes)) chunks[key] = value;
    for (const key of normalized.removed) delete chunks[key];
    return validateBundle({ version: FORMAT_VERSION, chunks });
  }

  function clone(bundle) {
    validateBundle(bundle);
    return { version: FORMAT_VERSION, chunks: copyStringMap(bundle.chunks) };
  }

  globalThis.VantaProjectChunks = Object.freeze({
    FORMAT_VERSION,
    MANIFEST_KEY,
    MAX_FANOUT_BYTES: 1024 * 1024,
    split,
    assemble,
    diff,
    apply,
    clone,
    validateDelta,
    validateBundle,
  });
})();
