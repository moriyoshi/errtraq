/** gzip through the Web `CompressionStream`, which Node 22 and Workers both provide. */
async function pipe(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const written = writer
    .write(bytes as BufferSource)
    .then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  await written;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
export const gzip = (bytes: Uint8Array) =>
  pipe(bytes, new CompressionStream("gzip"));
export const gunzip = (bytes: Uint8Array) =>
  pipe(bytes, new DecompressionStream("gzip"));
