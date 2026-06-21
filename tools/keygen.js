// keygen.js — 生成 Ed25519 密钥对（开发/发证服务器侧一次性运行）
// 用法： npm run keygen
// 产出： keys/private.pem (严密保管，绝不进客户端) + keys/public.pem (内置到 license.js)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keysDir = path.join(__dirname, "..", "keys");
fs.mkdirSync(keysDir, { recursive: true });

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
const pubPem = publicKey.export({ type: "spki", format: "pem" });

fs.writeFileSync(path.join(keysDir, "private.pem"), privPem);
fs.writeFileSync(path.join(keysDir, "public.pem"), pubPem);

console.log("✅ 密钥对已生成于 keys/");
console.log("   - keys/private.pem  → 只放发证服务器，绝不进客户端 / 绝不进 git");
console.log("   - keys/public.pem   → 复制其内容替换 src/license.js 的 DEMO_PUBLIC_KEY_PEM");
console.log("\n公钥内容：\n");
console.log(pubPem);
