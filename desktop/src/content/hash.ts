/** SHA-256 helpers for the browser dev shell only.
 *  In the Tauri shell the digest comes from Rust (`content_pack_stat`), because
 *  a checksum computed in the same process that reads the file is weaker proof
 *  than one computed by the native layer. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Text(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}
