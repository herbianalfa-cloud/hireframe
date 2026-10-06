import { signedBytesToHex, signingString, trimSecret } from '../../packages/shared/src/signing.js';

/**
 * The script's request signer (ADR-046). `computeHmac` is Apps Script's
 * `Utilities.computeHmacSha256Signature`, which returns signed bytes; the signed string and the
 * hex encoding come from the same shared module the server's verifier is tested against.
 */
export type ComputeHmac = (value: string, key: string) => number[];

export interface RequestSigner {
  /** The three `X-Hireframe-*` header values for one body. */
  headers: (body: string, timestampSeconds: number, nonce: string) => Record<string, string>;
}

export function createSigner(secret: string, computeHmac: ComputeHmac): RequestSigner {
  const key = trimSecret(secret);
  return {
    headers(body, timestampSeconds, nonce) {
      const timestamp = String(timestampSeconds);
      return {
        'X-Hireframe-Timestamp': timestamp,
        'X-Hireframe-Nonce': nonce,
        'X-Hireframe-Signature': signedBytesToHex(
          computeHmac(signingString(timestamp, nonce, body), key),
        ),
      };
    },
  };
}
