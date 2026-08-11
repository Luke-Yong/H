// ── AES-256-GCM encryption for API keys ──
// Uses a machine-specific key stored at ~/.h/.key.
// The key is auto-generated on first run and never leaves the machine.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { H_KEY_FILE } from "./hPaths";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

// ── Machine key ──

function getOrCreateMachineKey(): Buffer {
  if (fs.existsSync(H_KEY_FILE)) {
    return fs.readFileSync(H_KEY_FILE);
  }
  const key = crypto.randomBytes(KEY_LENGTH);
  fs.mkdirSync(path.dirname(H_KEY_FILE), { recursive: true });
  fs.writeFileSync(H_KEY_FILE, key);
  return key;
}

// ── Encrypt / Decrypt ──

export function encryptApiKeys(plaintext: string): string {
  const key = getOrCreateMachineKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptApiKeys(ciphertext: string): string {
  const key = getOrCreateMachineKey();
  const [ivHex, authTagHex, encHex] = ciphertext.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
