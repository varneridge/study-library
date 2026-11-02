// Pure TypeScript zero-dependency ZIP archive generator.
// Uses standard Store compression (method 0), perfectly compatible with Windows Explorer,
// macOS Archive Utility, Linux unzip, iOS Files and Android.

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function createZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const fileRecords: {
    nameBytes: Uint8Array;
    data: Uint8Array;
    crc: number;
    offset: number;
  }[] = [];

  let offset = 0;
  const localChunks: Uint8Array[] = [];

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name.replace(/\\/g, "/"));
    const crc = crc32(entry.data);
    const size = entry.data.length;

    // Local file header (30 bytes + name)
    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); // signature
    view.setUint16(4, 20, true);         // version needed (2.0)
    view.setUint16(6, 0, true);          // flags
    view.setUint16(8, 0, true);          // compression: 0 = Store
    view.setUint16(10, 0, true);         // mod time
    view.setUint16(12, 0, true);         // mod date
    view.setUint32(14, crc, true);       // crc-32
    view.setUint32(18, size, true);      // compressed size
    view.setUint32(22, size, true);      // uncompressed size
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);         // extra len
    header.set(nameBytes, 30);

    fileRecords.push({ nameBytes, data: entry.data, crc, offset });
    localChunks.push(header, entry.data);
    offset += header.length + size;
  }

  const centralOffset = offset;
  const centralChunks: Uint8Array[] = [];

  for (const rec of fileRecords) {
    // Central directory file header (46 bytes + name)
    const header = new Uint8Array(46 + rec.nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true); // signature
    view.setUint16(4, 20, true);         // version made by
    view.setUint16(6, 20, true);         // version needed
    view.setUint16(8, 0, true);          // flags
    view.setUint16(10, 0, true);         // compression: 0 = Store
    view.setUint16(12, 0, true);         // mod time
    view.setUint16(14, 0, true);         // mod date
    view.setUint32(16, rec.crc, true);   // crc-32
    view.setUint32(20, rec.data.length, true); // compressed size
    view.setUint32(24, rec.data.length, true); // uncompressed size
    view.setUint16(28, rec.nameBytes.length, true);
    view.setUint16(30, 0, true);         // extra field len
    view.setUint16(32, 0, true);         // file comment len
    view.setUint16(34, 0, true);         // disk number start
    view.setUint16(36, 0, true);         // internal attrs
    view.setUint32(38, 0, true);         // external attrs
    view.setUint32(42, rec.offset, true);// relative offset
    header.set(rec.nameBytes, 46);

    centralChunks.push(header);
    offset += header.length;
  }

  const centralSize = offset - centralOffset;

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true); // signature
  eocdView.setUint16(4, 0, true);        // disk num
  eocdView.setUint16(6, 0, true);        // disk with central dir
  eocdView.setUint16(8, fileRecords.length, true); // entries on this disk
  eocdView.setUint16(10, fileRecords.length, true); // total entries
  eocdView.setUint32(12, centralSize, true); // size of central dir
  eocdView.setUint32(16, centralOffset, true); // offset of central dir
  eocdView.setUint16(20, 0, true);       // comment len

  const totalLength = offset + 22;
  const out = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of [...localChunks, ...centralChunks, eocd]) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}
