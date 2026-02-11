export function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}

export async function sha256Text(text: string): Promise<string> {
  const enc = new TextEncoder().encode(text);
  return sha256Bytes(enc);
}

export function randomToken(len = 32): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * Canonical JSON stringify: stable key order.
 * Deterministic output is crucial for reproducible hashing.
 */
export function canonicalStringify(obj: any): string {
  const sortKeys = (v: any): any => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      const out: any = {};
      for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(obj), null, 2) + "\n";
}
