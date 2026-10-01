/**
 * A small PDF writer — just enough for printable paperwork (rental
 * agreements and return notes): A4 pages, Helvetica text with wrapping,
 * lines and boxes, and JPEG images (a signature). Zero dependencies, like
 * the rest of the server.
 *
 * Text uses the standard Helvetica fonts every PDF reader has, so nothing
 * is embedded. Their encoding is WinAnsi: £ — – ' ' " " • are mapped,
 * any other character outside it prints as "?". Widths come from the
 * Helvetica metrics so wrapping is accurate.
 *
 * JPEG only, because a JPEG goes into a PDF as-is (DCTDecode); the
 * signature pad exports one on a white background.
 */
'use strict';

// Helvetica advance widths (1/1000 em) for 32..126.
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
// Helvetica-Bold, same range.
const WB = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const WIN = { '£': 0xa3, '—': 0x97, '–': 0x96, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '©': 0xa9, '°': 0xb0, 'é': 0xe9, '×': 0xd7 };
const WIN_W = { 0xa3: 556, 0x97: 1000, 0x96: 556, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0xa9: 737, 0xb0: 400, 0xe9: 556, 0xd7: 584 };

/** Unicode string → array of WinAnsi byte codes. */
function encode(str) {
  const out = [];
  for (const ch of String(str ?? '')) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) out.push(c);
    else if (WIN[ch]) out.push(WIN[ch]);
    else if (ch === '\t') out.push(32);
    else if (c >= 0xa0 && c <= 0xff) out.push(c);
    else out.push(63);
  }
  return out;
}
const widthOf = (codes, size, bold) => codes.reduce((n, c) => n + ((c >= 32 && c <= 126) ? (bold ? WB : W)[c - 32] : WIN_W[c] || 556), 0) * size / 1000;
const pdfString = (codes) => '(' + codes.map((c) => (c === 40 || c === 41 || c === 92 ? '\\' + String.fromCharCode(c) : c < 32 || c > 126 ? '\\' + c.toString(8).padStart(3, '0') : String.fromCharCode(c))).join('') + ')';

/** Width and height of a baseline JPEG, from its SOF marker. */
function jpegSize(buf) {
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) throw new Error('not a JPEG');
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), components: buf[i + 9] };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('JPEG size not found');
}

const A4 = { w: 595.28, h: 841.89 };

class Doc {
  constructor({ margin = 48, footer = '' } = {}) {
    this.margin = margin; this.footer = footer;
    this.pages = []; this.images = [];
    this.newPage();
  }
  newPage() { this.ops = []; this.pages.push(this.ops); this.y = A4.h - this.margin; return this; }
  get width() { return A4.w - this.margin * 2; }
  /** Make room for `h` points, starting a new page if needed. */
  room(h) { if (this.y - h < this.margin + 24) this.newPage(); return this; }
  text(str, x, y, { size = 10, bold = false, color = null } = {}) {
    const codes = encode(str);
    this.ops.push(`BT ${color ? `${color.join(' ')} rg ` : ''}/${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(codes)} Tj ET${color ? ' 0 0 0 rg' : ''}`);
    return widthOf(codes, size, bold);
  }
  textWidth(str, size = 10, bold = false) { return widthOf(encode(str), size, bold); }
  /** Splits into lines no wider than maxWidth, honouring \n. */
  wrap(str, maxWidth, size = 10, bold = false) {
    const lines = [];
    for (const para of String(str ?? '').split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (this.textWidth(next, size, bold) <= maxWidth || !line) line = next;
        else { lines.push(line); line = word; }
        while (this.textWidth(line, size, bold) > maxWidth && line.length > 1) {
          // A single word longer than the line: break it.
          let cut = line.length - 1;
          while (cut > 1 && this.textWidth(line.slice(0, cut), size, bold) > maxWidth) cut--;
          lines.push(line.slice(0, cut)); line = line.slice(cut);
        }
      }
      lines.push(line);
    }
    return lines;
  }
  /** Flowing paragraph at the cursor, across pages as needed. */
  para(str, { size = 10, bold = false, gap = 4, indent = 0, leading = 1.3, color = null } = {}) {
    for (const line of this.wrap(str, this.width - indent, size, bold)) {
      this.room(size * leading);
      this.y -= size * leading;
      this.text(line, this.margin + indent, this.y, { size, bold, color });
    }
    this.y -= gap;
    return this;
  }
  heading(str, size = 13) { this.room(size * 2.2); this.y -= size * 0.6; return this.para(str, { size, bold: true, gap: 6 }); }
  line(x1, y1, x2, y2, { width = 0.6, grey = 0.75 } = {}) { this.ops.push(`${grey} G ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S 0 G`); return this; }
  rule(gap = 8) { this.room(gap * 2); this.y -= gap; this.line(this.margin, this.y, A4.w - this.margin, this.y); this.y -= gap; return this; }
  rect(x, y, w, h, { fill = null, stroke = 0.75 } = {}) {
    this.ops.push(`${fill ? `${fill.join(' ')} rg ${x} ${y} ${w} ${h} re f 0 0 0 rg ` : ''}${stroke != null ? `${stroke} G 0.6 w ${x} ${y} ${w} ${h} re S 0 G` : ''}`);
    return this;
  }
  /** Two-column label/value rows. */
  pairs(rows, { labelWidth = 130, size = 10 } = {}) {
    for (const [label, value] of rows) {
      const lines = this.wrap(value || '—', this.width - labelWidth, size);
      this.room(lines.length * size * 1.35 + 2);
      this.y -= size * 1.35;
      this.text(label, this.margin, this.y, { size: size - 1, color: [0.35, 0.38, 0.42] });
      lines.forEach((l, i) => this.text(l, this.margin + labelWidth, this.y - i * size * 1.35, { size }));
      this.y -= (lines.length - 1) * size * 1.35 + 2;
    }
    this.y -= 4;
    return this;
  }
  /** A table: columns [{ title, width (fraction), align }], rows of strings. */
  table(columns, rows, { size = 9 } = {}) {
    const xs = []; let x = this.margin;
    for (const c of columns) { xs.push(x); x += c.width * this.width; }
    const head = () => {
      this.room(size * 2.4);
      this.rect(this.margin, this.y - size * 1.8, this.width, size * 1.8, { fill: [0.93, 0.95, 0.95], stroke: null });
      columns.forEach((c, i) => this.text(c.title, xs[i] + 4, this.y - size * 1.25, { size, bold: true }));
      this.y -= size * 1.8;
    };
    head();
    for (const r of rows) {
      const cells = r.map((v, i) => this.wrap(v ?? '', columns[i].width * this.width - 8, size));
      const h = Math.max(...cells.map((c) => c.length)) * size * 1.3 + size * 0.7;
      if (this.y - h < this.margin + 24) { this.newPage(); head(); }
      cells.forEach((lines, i) => lines.forEach((l, k) => {
        const tx = columns[i].align === 'right' ? xs[i] + columns[i].width * this.width - 4 - this.textWidth(l, size) : xs[i] + 4;
        this.text(l, tx, this.y - size * 1.25 - k * size * 1.3, { size });
      }));
      this.y -= h;
      this.line(this.margin, this.y, A4.w - this.margin, this.y, { width: 0.4, grey: 0.85 });
    }
    this.y -= 8;
    return this;
  }
  /** A JPEG drawn at the cursor, fitted into maxW × maxH. */
  image(jpeg, { maxW = 220, maxH = 90, x = null } = {}) {
    const { width, height, components } = jpegSize(jpeg);
    const scale = Math.min(maxW / width, maxH / height, 1);
    const w = width * scale, h = height * scale;
    this.room(h + 4);
    const name = `Im${this.images.length + 1}`;
    this.images.push({ name, data: jpeg, width, height, components });
    this.y -= h;
    this.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${(x ?? this.margin).toFixed(2)} ${this.y.toFixed(2)} cm /${name} Do Q`);
    this.y -= 4;
    return this;
  }
  /** The finished file. */
  toBuffer() {
    const objs = [];
    const add = (body) => { objs.push(body); return objs.length; };
    const catalog = add(null), pagesObj = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const imgIds = this.images.map((im) => add({ stream: im.data, dict: `/Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /${im.components === 1 ? 'DeviceGray' : im.components === 4 ? 'DeviceCMYK' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode` }));
    const xobj = this.images.map((im, i) => `/${im.name} ${imgIds[i]} 0 R`).join(' ');
    const kids = [];
    const total = this.pages.length;
    this.pages.forEach((ops, i) => {
      const foot = [];
      const ft = `${this.footer ? this.footer + '   ·   ' : ''}Page ${i + 1} of ${total}`;
      foot.push(`BT 0.45 0.45 0.45 rg /F1 8 Tf ${this.margin} 28 Td ${pdfString(encode(ft))} Tj ET 0 0 0 rg`);
      const content = add({ stream: Buffer.from([...ops, ...foot].join('\n'), 'latin1'), dict: '' });
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${xobj ? ` /XObject << ${xobj} >>` : ''} >> /Contents ${content} 0 R >>`));
    });
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

    const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = parts[0].length;
    const offsets = [];
    objs.forEach((o, i) => {
      offsets.push(offset);
      let chunk;
      if (o && typeof o === 'object' && o.stream) {
        chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< ${o.dict} /Length ${o.stream.length} >>\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
      } else chunk = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
      parts.push(chunk); offset += chunk.length;
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
  }
}

module.exports = { Doc, jpegSize, A4 };
