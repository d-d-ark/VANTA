import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

const [, , configPath, rulesPath, credentialPrefix = "LLNK_VANTA_FIREBASE"] = process.argv;
if (!configPath || !rulesPath) {
  console.error("Usage: node deploy-rules.mjs <private-config.php> <database.rules.json> [credential-prefix]");
  process.exit(2);
}

if (!/^[A-Z][A-Z0-9_]*$/.test(credentialPrefix)) {
  throw new Error("Credential prefix is invalid.");
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function phpStringConstant(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*(['\"])(.*?)\\1\\s*;`, "s"));
  if (!match) throw new Error(`Missing ${name}.`);
  if (match[1] === "'") return match[2].replace(/\\\\'/g, "'").replace(/\\\\\\\\/g, "\\");
  return JSON.parse(`"${match[2].replace(/"/g, '\\"')}"`);
}

async function jsonResponse(response, label) {
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  if (!response.ok) {
    const detail = typeof value?.error === "string"
      ? value.error
      : typeof value?.error?.message === "string"
        ? value.error.message
        : typeof value?.message === "string"
          ? value.message
          : "No diagnostic returned.";
    throw new Error(`${label} failed (${response.status}): ${detail}`);
  }
  return value;
}

const [configSource, rulesSource] = await Promise.all([
  readFile(configPath, "utf8"),
  readFile(rulesPath, "utf8"),
]);
const rules = JSON.parse(rulesSource);
if (!rules?.rules) throw new Error("Firebase rules JSON is invalid.");

const clientEmail = phpStringConstant(configSource, `${credentialPrefix}_CLIENT_EMAIL`);
const databaseUrl = phpStringConstant(configSource, `${credentialPrefix}_DATABASE_URL`).replace(/\/+$/, "");
const privateKey = Buffer.from(
  phpStringConstant(configSource, `${credentialPrefix}_PRIVATE_KEY_BASE64`),
  "base64",
).toString("utf8");

const now = Math.floor(Date.now() / 1000);
const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const claims = base64url(JSON.stringify({
  iss: clientEmail,
  scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
  aud: "https://oauth2.googleapis.com/token",
  iat: now,
  exp: now + 3600,
}));
const unsigned = `${header}.${claims}`;
const signer = createSign("RSA-SHA256");
signer.update(unsigned);
signer.end();
const assertion = `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;

const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  }),
});
const tokenPayload = await jsonResponse(tokenResponse, "Firebase OAuth token request");
if (!tokenPayload?.access_token) throw new Error("Firebase OAuth response has no access token.");

const rulesUrl = `${databaseUrl}/.settings/rules.json?access_token=${encodeURIComponent(tokenPayload.access_token)}`;
await jsonResponse(await fetch(rulesUrl, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: rulesSource,
}), "Firebase rules update");

const deployed = await jsonResponse(await fetch(rulesUrl), "Firebase rules readback");
if (JSON.stringify(deployed) !== JSON.stringify(rules)) {
  throw new Error("Firebase rules readback verification failed.");
}
console.log("PASS: Firebase Realtime Database rules deployed and verified.");
