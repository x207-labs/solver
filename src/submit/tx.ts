import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { base58Decode, base58Encode } from "./base58.js";

const ED25519_KEY_TYPE = 0;
const FUNCTION_CALL_ACTION = 2;
const TRANSACTION_V1_PREFIX = 1;
const NONCE_GAS_KEY = 1;
const NONCE_MODE_MONOTONIC = 0;
// DER prefix of a PKCS#8 ed25519 private key; the 32-byte seed follows.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface SolverKey {
  /** `ed25519:<base58>` public key as the access key list shows it. */
  publicKey: string;
  publicKeyBytes: Uint8Array;
  /** Signs the sha256 of the transaction bytes. */
  signHash(hash: Uint8Array): Uint8Array;
}

/** Reads `ed25519:<base58 of 64 bytes (seed + public key) or 32 bytes (seed)>`. */
export function parseSecretKey(text: string): SolverKey {
  const match = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(text.trim());
  if (match === null) throw new Error("SOLVER_PRIVATE_KEY must look like ed25519:<base58>");
  const raw = base58Decode(match[1]!);
  if (raw.length !== 64 && raw.length !== 32) throw new Error("SOLVER_PRIVATE_KEY must be 32 or 64 bytes");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKeyBytes = new Uint8Array(spki.subarray(spki.length - 32));
  if (raw.length === 64 && Buffer.compare(Buffer.from(raw.subarray(32)), Buffer.from(publicKeyBytes)) !== 0) {
    throw new Error("SOLVER_PRIVATE_KEY: public part does not match the seed");
  }
  return {
    publicKey: `ed25519:${base58Encode(publicKeyBytes)}`,
    publicKeyBytes,
    signHash: (hash) => new Uint8Array(sign(null, Buffer.from(hash), privateKey)),
  };
}

class Writer {
  private chunks: Buffer[] = [];
  u8(value: number) {
    this.chunks.push(Buffer.from([value]));
  }
  u16(value: number) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(value);
    this.chunks.push(b);
  }
  u32(value: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value);
    this.chunks.push(b);
  }
  u64(value: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(value);
    this.chunks.push(b);
  }
  u128(value: bigint) {
    this.u64(value & 0xffffffffffffffffn);
    this.u64(value >> 64n);
  }
  bytes(value: Uint8Array) {
    this.chunks.push(Buffer.from(value));
  }
  string(value: string) {
    const b = Buffer.from(value, "utf8");
    this.u32(b.length);
    this.chunks.push(b);
  }
  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export interface FunctionCallTx {
  signerId: string;
  receiverId: string;
  nonce: bigint;
  blockHash: Uint8Array;
  methodName: string;
  args: unknown;
  /** Gas in gas units, deposit in yoctoNEAR. */
  gas: bigint;
  deposit: bigint;
  /**
   * Nonce lane of a gas key (NEP-611, ADR-11b), 0..1023. When set, the transaction is `Transaction::V1`
   * (`0x01` prefix, `GasKeyNonce { nonce, nonce_index }`, `NonceMode::Monotonic`) and gas is paid by the key's balance.
   */
  nonceIndex?: number;
}

/** Borsh bytes of a transaction with one FunctionCall action (NEAR protocol). */
export function encodeTransaction(tx: FunctionCallTx, key: SolverKey): Buffer {
  const w = new Writer();
  const gasKey = tx.nonceIndex !== undefined;
  if (gasKey) {
    if (!Number.isInteger(tx.nonceIndex) || tx.nonceIndex! < 0 || tx.nonceIndex! > 1023) throw new Error("nonceIndex must be an integer 0..1023");
    w.u8(TRANSACTION_V1_PREFIX);
  }
  w.string(tx.signerId);
  w.u8(ED25519_KEY_TYPE);
  w.bytes(key.publicKeyBytes);
  if (gasKey) {
    w.u8(NONCE_GAS_KEY);
    w.u64(tx.nonce);
    w.u16(tx.nonceIndex!);
  } else {
    w.u64(tx.nonce);
  }
  w.string(tx.receiverId);
  w.bytes(tx.blockHash);
  w.u32(1);
  w.u8(FUNCTION_CALL_ACTION);
  w.string(tx.methodName);
  const args = Buffer.from(JSON.stringify(tx.args), "utf8");
  w.u32(args.length);
  w.bytes(args);
  w.u64(tx.gas);
  w.u128(tx.deposit);
  if (gasKey) w.u8(NONCE_MODE_MONOTONIC);
  return w.finish();
}

export interface SignedTx {
  bytes: Buffer;
  /** Transaction hash, base58, as RPC shows it. */
  hash: string;
}

export function signTransaction(tx: FunctionCallTx, key: SolverKey): SignedTx {
  const body = encodeTransaction(tx, key);
  const digest = createHash("sha256").update(body).digest();
  const signature = key.signHash(digest);
  return { bytes: Buffer.concat([body, Buffer.from([ED25519_KEY_TYPE]), Buffer.from(signature)]), hash: base58Encode(digest) };
}
