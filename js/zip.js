// Bundles several files into one .zip for "download selected photos".
// Files are stored as-is (no compression): photos are already compressed, so
// this is fast and needs no library.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Makes names unique inside the zip: "cat.webp", "cat (2).webp", …
export function uniqueNames(names) {
  const seen = new Map();
  return names.map(name => {
    const key = name.toLowerCase();
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return n === 1 ? name : name.replace(/(\.[^.]*)?$/, ext => ` (${n})${ext}`);
  });
}

// files: [{ name, blob }] -> Blob (application/zip)
export async function makeZip(files) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const local = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const name = enc.encode(file.name);
    const crc = crc32(data);

    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); // local file header
    head.setUint16(4, 20, true);         // version needed
    head.setUint16(6, 0x0800, true);     // names are UTF-8
    head.setUint16(8, 0, true);          // stored
    head.setUint16(10, time, true);
    head.setUint16(12, date, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, data.length, true);
    head.setUint16(26, name.length, true);
    local.push(head, name, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); // central directory header
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(entry, name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...local, ...central, end], { type: 'application/zip' });
}

// Reads one file out of a .zip without loading the whole thing (Procreate
// files are zips with a preview at QuickLook/Thumbnail.png). Returns a Blob or null.
export async function readZipEntry(blob, wanted) {
  const slice = async (start, end) => new DataView(await blob.slice(start, end).arrayBuffer());
  const tailSize = Math.min(blob.size, 22 + 0xffff);
  const tail = await slice(blob.size - tailSize, blob.size);
  let eocd = -1;
  for (let i = tailSize - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff && eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) {
    const z64 = await slice(Number(tail.getBigUint64(eocd - 12, true)), Number(tail.getBigUint64(eocd - 12, true)) + 56);
    cdSize = Number(z64.getBigUint64(40, true));
    cdOffset = Number(z64.getBigUint64(48, true));
  }
  const cd = await slice(cdOffset, cdOffset + cdSize);
  const dec = new TextDecoder();
  for (let p = 0; p + 46 <= cd.byteLength && cd.getUint32(p, true) === 0x02014b50;) {
    const method = cd.getUint16(p + 10, true);
    let size = cd.getUint32(p + 20, true);
    const usize = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    let offset = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    if (name === wanted) {
      // ZIP64: real sizes/offset live in the 0x0001 extra field
      for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen;) {
        const id = cd.getUint16(e, true), len = cd.getUint16(e + 2, true);
        if (id === 1) {
          let q = e + 4;
          if (usize === 0xffffffff) q += 8;
          if (size === 0xffffffff) { size = Number(cd.getBigUint64(q, true)); q += 8; }
          if (offset === 0xffffffff) offset = Number(cd.getBigUint64(q, true));
        }
        e += 4 + len;
      }
      const local = await slice(offset, offset + 30);
      const start = offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
      const data = blob.slice(start, start + size);
      if (method === 0) return data;
      if (method === 8) return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
