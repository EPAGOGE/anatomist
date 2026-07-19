import { createMLDSA65 } from '@oqs/liboqs-js';

export interface MLDSAKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export async function generateKeyPair(): Promise<MLDSAKeyPair> {
  const signer = await createMLDSA65();
  try {
    const kp = signer.generateKeyPair();
    return { publicKey: kp.publicKey, secretKey: kp.secretKey };
  } finally {
    signer.destroy();
  }
}

export async function sign(message: Uint8Array, secretKey: Uint8Array): Promise<Uint8Array> {
  const signer = await createMLDSA65();
  try {
    return signer.sign(message, secretKey);
  } finally {
    signer.destroy();
  }
}

export async function verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  const signer = await createMLDSA65();
  try {
    return signer.verify(message, signature, publicKey);
  } finally {
    signer.destroy();
  }
}
