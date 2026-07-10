/**
 * Shared pure helpers for the account layer.
 */

/** Generate a short random account ID */
export function generateAccountId(): string {
    return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

/** Browser-safe base64 encode (no Node Buffer) */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}
