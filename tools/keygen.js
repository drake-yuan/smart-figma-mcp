// keygen.js — generate an Ed25519 key pair (run once on the dev / issuing server).
// Usage:  npm run keygen
// Output: keys/private.pem (keep strictly secret, never ship to clients)
//         keys/public.pem  (embed into license.js)

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

console.log("✅ Key pair generated in keys/");
console.log("   - keys/private.pem  -> issuing server only; never ship to clients / never commit to git");
console.log("   - keys/public.pem   -> copy its contents into DEMO_PUBLIC_KEY_PEM in src/license.js");
console.log("\nPublic key:\n");
console.log(pubPem);
