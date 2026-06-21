// license.js — 离线 Ed25519 license 验签（v2）
// 物理目标：30 天才联网续期一次，平时调用全程零网络，根治 stdio 跨海超时假死。
//
// license token 格式： base64url(payloadJSON) + "." + base64url(signature)
// 客户端内置 PUBLIC_KEY 本地验签，私钥只在你的发证服务器(tools/issue-license.js)。
//
// v2 新增：CRL 吊销列表检查、续期提醒、token 版本号

import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// ⚠️ 演示用公钥。真实场景：跑 `npm run keygen` 生成你自己的密钥对，
//   把这里替换成你的公钥(PEM)，私钥严密保管在发证服务器。
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

// ━━━ CRL 吊销列表 ━━━
const CRL_PATH = path.join(os.homedir(), ".smart-figma", "crl.json");
const CRL_REFRESH_DAYS = 30;

function loadCRL() {
  try {
    return JSON.parse(fs.readFileSync(CRL_PATH, "utf8"));
  } catch {
    return { version: 1, revoked: [] };
  }
}

/** 检查 jti 是否在吊销列表中 */
function isRevoked(jti) {
  if (!jti) return false;
  const crl = loadCRL();
  const hash = crypto.createHash("sha256").update(jti).digest("hex").slice(0, 16);
  return crl.revoked.includes(hash);
}

/**
 * 离线验签 license。全程零网络。
 * @param {string} token  license token
 * @param {string} publicKeyPem  内置公钥
 * @param {string} deviceFingerprint  当前机器指纹
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

  // 1) 验签：被篡改的 payload 会直接失败
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(publicKeyPem);
  } catch {
    return { ok: false, reason: "bad_public_key" };
  }
  const signatureValid = crypto.verify(null, payloadBuf, publicKey, sigBuf);
  if (!signatureValid) return { ok: false, reason: "invalid_signature" };

  // 2) CRL 吊销检查
  if (payload.jti && isRevoked(payload.jti)) {
    return { ok: false, reason: "revoked", payload };
  }

  // 3) 过期检查
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) {
    return { ok: false, reason: "expired", payload };
  }

  // 3b) 续期提醒：过期前 7 天
  let renewal;
  if (payload.exp) {
    const daysLeft = Math.ceil((payload.exp - Date.now()) / (24 * 3600 * 1000));
    if (daysLeft <= 7 && daysLeft > 0) {
      renewal = { needed: true, daysLeft, exp: payload.exp };
    }
  }

  // 4) 设备绑定（≤2 台，防止一个 license 全公司共用）
  const devices = Array.isArray(payload.devices) ? payload.devices : [];
  if (devices.length > 0 && !devices.includes(deviceFingerprint)) {
    return { ok: false, reason: "device_unbound", payload };
  }

  return { ok: true, payload, renewal };
}

/**
 * 设备指纹：机器级稳定标识(去敏感化哈希)。
 * 真实实现可叠加 MAC/主板序列号；此处用 hostname+platform+cpu 做演示。
 */
export function deviceFingerprint() {
  return crypto
    .createHash("sha256")
    .update(`${os.hostname()}|${os.platform()}|${os.arch()}|${(os.cpus()[0] || {}).model || ""}`)
    .digest("hex")
    .slice(0, 32);
}
