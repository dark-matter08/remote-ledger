// Encrypted-at-rest secret store (BYO API keys).
//
// Decision: OS keychain + encrypted-file fallback. This implements the encrypted
// fallback (zero native deps, fully portable): values are AES-256-GCM encrypted
// with a per-machine master key in data/.master.key (0600), and the ciphertext is
// stored in the `secrets` table. The SecretsBackend interface leaves room to add a
// keychain backend (e.g. @napi-rs/keyring) later without touching callers.
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDb, DB_PATH } from "./sqlite.server";

const MASTER_KEY_PATH =
  process.env.JOBS_MASTER_KEY || resolve(dirname(DB_PATH), ".master.key");

function masterKey(): Buffer {
  if (existsSync(MASTER_KEY_PATH)) {
    return Buffer.from(readFileSync(MASTER_KEY_PATH, "utf8").trim(), "hex");
  }
  mkdirSync(dirname(MASTER_KEY_PATH), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(MASTER_KEY_PATH, key.toString("hex"), { mode: 0o600 });
  try {
    chmodSync(MASTER_KEY_PATH, 0o600);
  } catch {}
  return key;
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(".");
}

function decrypt(blob: string): string {
  const [ivB, tagB, dataB] = blob.split(".");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    masterKey(),
    Buffer.from(ivB, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function setSecret(name: string, value: string): void {
  if (!value) {
    deleteSecret(name);
    return;
  }
  getDb()
    .prepare(
      "INSERT INTO secrets (name,ciphertext,updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET ciphertext=excluded.ciphertext, updated_at=excluded.updated_at"
    )
    .run(name, encrypt(value), new Date().toISOString());
}

export function getSecret(name: string): string | null {
  // env var wins (lets users do plain .env / CI without storing in the DB)
  const envName = name.toUpperCase();
  if (process.env[envName]) return process.env[envName] as string;
  const row = getDb().prepare("SELECT ciphertext FROM secrets WHERE name=?").get(name) as
    | { ciphertext: string }
    | undefined;
  if (!row) return null;
  try {
    return decrypt(row.ciphertext);
  } catch {
    return null;
  }
}

export function hasSecret(name: string): boolean {
  return !!getSecret(name);
}

export function deleteSecret(name: string): void {
  getDb().prepare("DELETE FROM secrets WHERE name=?").run(name);
}

// names of secrets currently set (never returns the values)
export function listSecretNames(): string[] {
  const rows = getDb().prepare("SELECT name FROM secrets").all() as { name: string }[];
  return rows.map((r) => r.name);
}
