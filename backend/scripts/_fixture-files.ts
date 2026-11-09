import { crc32 } from "node:zlib";

/**
 * Minimal but REAL files for the check scripts. Uploads are verified by content (SECURITY_AUDIT.md
 * M-5), so a fixture must actually be the format it claims. Each takes a `salt` that lands in the
 * bytes, so two fixtures differ (distinct checksums) unless a test wants a duplicate.
 */

export function pdfBytes(salt = ""): Buffer {
  return Buffer.from(`%PDF-1.4\n% ${salt}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
}

export function pngBytes(salt = ""): Buffer {
  // Signature + a tEXt chunk carrying the salt (CRCs aren't checked by the detector; this is a fixture).
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`tEXt${salt}`)]);
}

export function jpegBytes(salt = ""): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`JFIF${salt}`), Buffer.from([0xff, 0xd9])]);
}

/** A stored (uncompressed) ZIP with the given entries — the container DOCX and XLSX are. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;

export function docxBytes(salt = ""): Buffer {
  return zip({ "[Content_Types].xml": CONTENT_TYPES, "word/document.xml": `<w:document><!-- ${salt} --></w:document>` });
}

export function xlsxBytes(salt = ""): Buffer {
  return zip({ "[Content_Types].xml": CONTENT_TYPES, "xl/workbook.xml": `<workbook><!-- ${salt} --></workbook>` });
}

/** A Markdown document (salt lands in the text, so it's also a searchable marker). */
export function markdownBytes(salt = ""): Buffer {
  return Buffer.from(`# Project notes ${salt}\n\n- first point\n- second **bold** point\n\n| Col | Val |\n|---|---|\n| a | 1 |\n`);
}

/** A plain-text document. */
export function textBytes(salt = ""): Buffer {
  return Buffer.from(`Meeting minutes ${salt}\nAttendees: Asha, Ravi\nNext review in two weeks.\n`);
}

/** A ZIP that is neither DOCX nor XLSX (no Office parts). */
export function plainZipBytes(salt = ""): Buffer {
  return zip({ "readme.txt": `just a zip ${salt}` });
}
