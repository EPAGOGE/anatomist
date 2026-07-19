import { blake3 } from '@noble/hashes/blake3.js';

export function hash(data: Uint8Array): Uint8Array {
  return blake3(data);
}
