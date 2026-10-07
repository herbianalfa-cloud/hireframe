import {
  signedBytesToHex,
  signingPrefix,
  trimSecret,
  utf8Bytes,
} from '../../packages/shared/src/signing.js';

/**
 * The script's request signer (ADR-046). The body is already UTF-8 bytes (encoded once by the
 * caller, and these same bytes are what it posts), so what is signed is exactly what is sent.
 * `computeHmac` is Apps Script's byte-array `Utilities.computeHmacSha256Signature`, wrapped to take
 * unsigned bytes (0..255) and return signed ones; the signed prefix and the hex encoding come
 * from the same shared module the server's verifier is tested against.
 */
export type ComputeHmac = (value: readonly number[], key: readonly number[]) => number[];

export interface RequestSigner {
  /** The three `X-Hireframe-*` header values for one body's UTF-8 bytes. */
  headers: (
    body: readonly number[],
    timestampSeconds: number,
    nonce: string,
  ) => Record<string, string>;
}

export function createSigner(secret: string, computeHmac: ComputeHmac): RequestSigner {
  const key = utf8Bytes(trimSecret(secret));
  return {
    headers(body, timestampSeconds, nonce) {
      const timestamp = String(timestampSeconds);
      const signed = utf8Bytes(signingPrefix(timestamp, nonce)).concat(body);
      return {
        'X-Hireframe-Timestamp': timestamp,
        'X-Hireframe-Nonce': nonce,
        'X-Hireframe-Signature': signedBytesToHex(computeHmac(signed, key)),
      };
    },
  };
}
