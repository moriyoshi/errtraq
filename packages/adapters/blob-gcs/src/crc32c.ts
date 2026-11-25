const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();
/** Incremental CRC-32C (Castagnoli), the checksum GCS reports in `x-goog-hash`. */
export class Crc32c {
  private state = 0xffffffff;
  update(bytes: Uint8Array): void {
    let c = this.state;
    for (let i = 0; i < bytes.length; i++)
      c = (TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
    this.state = c;
  }
  /** Big-endian base64, as GCS encodes it. */
  digestBase64(): string {
    const value = (this.state ^ 0xffffffff) >>> 0;
    const bytes = new Uint8Array([
      value >>> 24,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ]);
    return btoa(String.fromCharCode(...bytes));
  }
}
