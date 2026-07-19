import { blake3, ed25519, mldsa } from '../src/index.js';

const message = new TextEncoder().encode('EPAGOGE crypto verification 2026-05-19');

console.log('--- BLAKE3 ---');
const digest = blake3.hash(message);
console.log(`  digest: ${Buffer.from(digest).toString('hex')}`);
console.log(`  length: ${digest.length} bytes`);

console.log('\n--- Ed25519 (libsodium) ---');
const edKp = await ed25519.generateKeyPair();
console.log(`  pubkey: ${edKp.publicKey.length} bytes, secret: ${edKp.secretKey.length} bytes`);
const edSig = await ed25519.sign(message, edKp.secretKey);
console.log(`  signature: ${edSig.length} bytes`);
const edOk = await ed25519.verify(edSig, message, edKp.publicKey);
if (!edOk) throw new Error('Ed25519 verification FAILED');
console.log('  verify: ok');

// Tamper test
const tampered = new Uint8Array(message);
tampered[0] ^= 0xff;
const edTamper = await ed25519.verify(edSig, tampered, edKp.publicKey);
if (edTamper) throw new Error('Ed25519 accepted tampered message');
console.log('  tamper rejected: ok');

console.log('\n--- ML-DSA-65 (liboqs) ---');
const mlKp = await mldsa.generateKeyPair();
console.log(`  pubkey: ${mlKp.publicKey.length} bytes, secret: ${mlKp.secretKey.length} bytes`);
const mlSig = await mldsa.sign(message, mlKp.secretKey);
console.log(`  signature: ${mlSig.length} bytes`);
const mlOk = await mldsa.verify(message, mlSig, mlKp.publicKey);
if (!mlOk) throw new Error('ML-DSA verification FAILED');
console.log('  verify: ok');

const mlTamper = await mldsa.verify(tampered, mlSig, mlKp.publicKey);
if (mlTamper) throw new Error('ML-DSA accepted tampered message');
console.log('  tamper rejected: ok');

console.log('\nAll three primitives verified in Node.');
