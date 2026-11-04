import zlib from 'node:zlib';

/*
 * Dependency-free text extraction for knowledge files (used by direct AI mode, which has no Dify parser).
 * DOCX / PPTX / XLSX are ZIP files of XML; PDFs are parsed best-effort (FlateDecode streams, Tj/TJ text).
 * Scanned PDFs (images) contain no text – the caller reports that to the shop owner.
 */

// ---------- ZIP (central directory) ----------
export function unzip(buf) {
  const files = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);
    files[name] = () => (method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : Buffer.alloc(0));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const xmlDecode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');

function docxText(files) {
  const xml = files['word/document.xml']?.().toString('utf8') || '';
  return xmlDecode(xml.replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<w:br[^>]*\/>/g, '\n').replace(/<[^>]+>/g, ''));
}

function pptxText(files) {
  const slides = Object.keys(files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  return slides.map((f, i) => `Slide ${i + 1}\n` + xmlDecode((files[f]().toString('utf8').match(/<a:t>[^<]*<\/a:t>|<\/a:p>/g) || []).map((t) => (t === '</a:p>' ? '\n' : t.slice(5, -6))).join(''))).join('\n\n');
}

function xlsxText(files) {
  const shared = (files['xl/sharedStrings.xml']?.().toString('utf8').match(/<si>[\s\S]*?<\/si>/g) || []).map((si) => xmlDecode((si.match(/<t[^>]*>[^<]*<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  const sheets = Object.keys(files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort();
  return sheets.map((f) => (files[f]().toString('utf8').match(/<row[\s\S]*?<\/row>/g) || []).map((row) => (row.match(/<c [^>]*>[\s\S]*?<\/c>/g) || []).map((c) => {
    const v = c.match(/<v>([^<]*)<\/v>/)?.[1] ?? c.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? '';
    return /t="s"/.test(c) ? shared[+v] ?? '' : xmlDecode(v);
  }).join(' | ')).join('\n')).join('\n\n');
}

// ---------- PDF (best effort) ----------
function pdfString(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e) => ({ n: '\n', r: '', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' })[e] ?? String.fromCharCode(parseInt(e, 8)));
}

function textFromContent(content) {
  const out = [];
  for (const block of content.match(/BT[\s\S]*?ET/g) || []) {
    let line = '';
    const re = /\((?:\\.|[^\\)])*\)\s*Tj|\[(?:[^\]]*)\]\s*TJ|T\*|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+T[dD]|'|"/g;
    let m;
    while ((m = re.exec(block))) {
      const tok = m[0];
      if (tok.endsWith('Tj')) line += pdfString(tok.slice(1, tok.lastIndexOf(')')));
      else if (tok.endsWith('TJ')) {
        for (const part of tok.match(/\((?:\\.|[^\\)])*\)|-?\d+(?:\.\d+)?/g) || []) {
          if (part.startsWith('(')) line += pdfString(part.slice(1, -1));
          else if (Number(part) < -200) line += ' '; // large negative kerning = word gap
        }
      } else if (/T[dD*]$/.test(tok) || tok === 'T*') {
        if (m[2] !== undefined && Number(m[2]) === 0) line += ' ';
        else { out.push(line); line = ''; }
      }
    }
    out.push(line);
  }
  return out.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

export function pdfText(buf) {
  const s = buf.toString('latin1');
  const parts = [];
  const re = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const dict = m[1];
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    let data = buf.subarray(start, end);
    if (/\/Subtype\s*\/Image/.test(dict)) continue;
    try {
      if (/FlateDecode/.test(dict)) data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      else if (/\/Filter/.test(dict)) continue; // other filters (DCT, LZW…) – skip
    } catch { continue; }
    const txt = textFromContent(data.toString('latin1'));
    if (txt) parts.push(txt);
    re.lastIndex = end;
  }
  return parts.join('\n');
}

/** Returns plain text, or '' when nothing readable was found. */
export function extractText(filename, buffer) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  try {
    if (['txt', 'md', 'markdown', 'csv', 'json', 'xml'].includes(ext)) return buffer.toString('utf8');
    if (ext === 'pdf') return pdfText(buffer);
    if (['docx', 'pptx', 'xlsx'].includes(ext)) {
      const files = unzip(buffer);
      return (ext === 'docx' ? docxText(files) : ext === 'pptx' ? pptxText(files) : xlsxText(files)).replace(/\n{3,}/g, '\n\n').trim();
    }
  } catch (e) {
    console.warn('[extract]', filename, e.message);
  }
  return '';
}
