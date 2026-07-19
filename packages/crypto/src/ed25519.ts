import sodium from 'libsodium-wrappers';

let readyPromise: Promise<void> | null = null;

export async function ready(): Promise<void> {
  if (!readyPromise) {
    readyPromise = sodium.ready;
  }
  return readyPromise;
}

export interface Ed25519KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export async function generateKeyPair(): Promise<Ed25519KeyPair> {
  await ready();
  const kp = sodium.crypto_sign_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

export async function sign(message: Uint8Array, secretKey: Uint8Array): Promise<Uint8Array> {
  await ready();
  return sodium.crypto_sign_detached(message, secretKey);
}

export async function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  await ready();
  return sodium.crypto_sign_verify_detached(signature, message, publicKey);
}
