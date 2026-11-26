/**
 * codigo/zip_util.mjs
 * Generador nativo de archivos .ZIP en Node.js puro (usando node:zlib, sin dependencias externas).
 * Empaqueta todos los certificados originales individuales en un solo archivo .ZIP descargable
 * compatible con Windows Explorer, WinRAR, 7-Zip, macOS y celulares.
 */
import zlib from 'node:zlib';

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {Array<{nombre: string, buffer: Buffer}>} archivos
 * @returns {Buffer} Buffer del archivo .ZIP
 */
export function crearArchivoZip(archivos) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const arch of archivos) {
    const nameBuf = Buffer.from(arch.nombre, 'utf8');
    const uncompressed = Buffer.isBuffer(arch.buffer) ? arch.buffer : Buffer.from(arch.buffer);
    const compressed = zlib.deflateRawSync(uncompressed);
    const crc = crc32(uncompressed);

    // Local File Header (30 bytes + name)
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // signature
    lh.writeUInt16LE(20, 4);         // version needed (2.0)
    lh.writeUInt16LE(0x0800, 6);     // flags (UTF-8 filename)
    lh.writeUInt16LE(8, 8);          // compression method (8 = deflate)
    lh.writeUInt16LE(0, 10);         // mod time
    lh.writeUInt16LE(0x577a, 12);    // mod date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(uncompressed.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);         // extra len

    localParts.push(lh, nameBuf, compressed);

    // Central Directory File Header (46 bytes + name)
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // signature
    ch.writeUInt16LE(20, 4);         // version made by
    ch.writeUInt16LE(20, 6);         // version needed
    ch.writeUInt16LE(0x0800, 8);     // flags (UTF-8)
    ch.writeUInt16LE(8, 10);         // compression method
    ch.writeUInt16LE(0, 12);         // mod time
    ch.writeUInt16LE(0x577a, 14);    // mod date
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compressed.length, 20);
    ch.writeUInt32LE(uncompressed.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);         // extra len
    ch.writeUInt16LE(0, 32);         // comment len
    ch.writeUInt16LE(0, 34);         // disk start
    ch.writeUInt16LE(0, 36);         // internal attrs
    ch.writeUInt32LE(0, 38);         // external attrs
    ch.writeUInt32LE(offset, 42);    // relative offset of local header

    centralParts.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralParts);

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(archivos.length, 8);
  eocd.writeUInt16LE(archivos.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}
