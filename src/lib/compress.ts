/** gzip helpers built on the platform's native CompressionStream (no extra library). */

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Response(text).body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipToText(bytes: Uint8Array): Promise<string> {
  // Accept plain (already-decoded) JSON too, in case a proxy transparently decompressed it.
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return new TextDecoder().decode(bytes);
  const stream = new Response(bytes as BodyInit).body!.pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}
