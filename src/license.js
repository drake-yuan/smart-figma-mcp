// license.js — offline Ed25519 license verification (v2)
// Goal: phone home at most once every 30 days; everyday calls are fully offline,
// which eliminates cross-border stdio timeouts.
//
// License token format: base64url(payloadJSON) + "." + base64url(signature)
// The client embeds only PUBLIC_KEY for local verification; the private key lives
// solely on your issuing server (tools/issue-license.js).
//
// v2 additions: CRL revocation-list check, renewal reminder, token version field.

import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// ⚠️ Demo public key. In production: run `npm run keygen` to generate your own key
//    pair, replace this with your public key (PEM), and keep the private key secret
//    on the issuing server.
export const DEMO_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA6m1Q0Yc1y3yJ3y0Zr0Hq1xq0Q1mGq2Qe1xq0Q1mGq2=
-----END PUBLIC KEY-----`;

function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ━━━ CRL (certificate revocation list) ━━━
const CRL_PATH = path.join(os.homedir(), ".smart-figma", "crl.json");
const CRL_REFRESH_DAYS = 30;

function loadCRL() {
  try {
    return JSON.parse(fs.readFileSync(CRL_PATH, "utf8"));
  } catch {
    return { version: 1, revoked: [] };
  }
}

/** Check whether a jti is present in the revocation list. */
function isRevoked(jti) {
  if (!jti) return false;
  const crl = loadCRL();
  const hash = crypto.createHash("sha256").update(jti).digest("hex").slice(0, 16);
  return crl.revoked.includes(hash);
}

/**
 * Verify a license offline. Fully network-free.
 * @param {string} token             license token
 * @param {string} publicKeyPem      embedded public key
 * @param {string} deviceFingerprint current machine fingerprint
 * @returns {{ok:boolean, reason?:string, payload?:object, renewal?:object}}
 */
export function verifyLicenseOffline(token, publicKeyPem, deviceFingerprint) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { ok: false, reason: "malformed_token" };
  }

  const [payloadB64, sigB64] = token.split(".");
  let payloadBuf, sigBuf, payload;
  try {
    payloadBuf = b64urlDecode(payloadB64);
    sigBuf = b64urlDecode(sigB64);
    payload = JSON.parse(payloadBuf.toString("utf8"));
  } catch {
    return { ok: false, reason: "decode_failed" };
  }

  // 1) Signature check: a tampered payload fails here.
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(publicKeyPem);
  } catch {
    return { ok: false, reason: "bad_public_key" };
  }
  const signatureValid = crypto.verify(null, payloadBuf, publicKey, sigBuf);
  if (!signatureValid) return { ok: false, reason: "invalid_signature" };

  // 2) Revocation check.
  if (payload.jti && isRevoked(payload.jti)) {
    return { ok: false, reason: "revoked", payload };
  }

  // 3) Expiry check.
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) {
    return { ok: false, reason: "expired", payload };
  }

  // 3b) Renewal reminder: within 7 days of expiry.
  let renewal;
  if (payload.exp) {
    const daysLeft = Math.ceil((payload.exp - Date.now()) / (24 * 3600 * 1000));
    if (daysLeft <= 7 && daysLeft > 0) {
      renewal = { needed: true, daysLeft, exp: payload.exp };
    }
  }

  // 4) Device binding (<= 2 devices, prevents one license being shared company-wide).
  const devices = Array.isArray(payload.devices) ? payload.devices : [];
  if (devices.length > 0 && !devices.includes(deviceFingerprint)) {
    return { ok: false, reason: "device_unbound", payload };
  }

  return { ok: true, payload, renewal };
}

/**
 * Device fingerprint: a stable machine-level identifier (de-identified hash).
 * A production build could fold in MAC / mainboard serial; here we use
 * hostname + platform + cpu for demonstration.
 */
export function deviceFingerprint() {
  return crypto
    .createHash("sha256")
    .update(`${os.hostname()}|${os.platform()}|${os.arch()}|${(os.cpus()[0] || {}).model || ""}`)
    .digest("hex")
    .slice(0, 32);
}
