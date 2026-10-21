/** Small real classic-xref PDFs. Offsets/stream lengths count bytes; no external PDF package is needed. */
import { deflateSync } from 'node:zlib'
const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1')
export function pdf(objects, { version = '1.4', trailer = '' } = {}) {
  const chunks = [Buffer.from('%PDF-' + version + '\n%\xe2\xe3\xcf\xd3\n', 'latin1')], offsets = [0]
  let offset = chunks[0].length
  for (const [index, value] of objects.entries()) {
    offsets.push(offset)
    const item = Buffer.concat([Buffer.from(String(index + 1) + ' 0 obj\n'), bytes(value), Buffer.from('\nendobj\n')])
    chunks.push(item); offset += item.length
  }
  const xref = 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n' + offsets.slice(1).map(at => String(at).padStart(10, '0') + ' 00000 n \n').join('')
  chunks.push(Buffer.from(xref + 'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R ' + trailer + ' >>\nstartxref\n' + offset + '\n%%EOF\n'))
  return Buffer.concat(chunks)
}
export function stream(content, { deflate = false, extra = '', length, packed } = {}) {
  const encoded = packed ?? (deflate ? deflateSync(bytes(content)) : bytes(content))
  return Buffer.concat([Buffer.from('<< /Length ' + (length ?? encoded.length) + (deflate ? ' /Filter /FlateDecode' : '') + ' ' + extra + ' >>\nstream\n'), encoded, Buffer.from('\nendstream')])
}
export function show(value) {
  let text = ''
  for (const byte of bytes(value)) text += byte < 32 || byte > 126 ? '\\' + byte.toString(8).padStart(3, '0') : [40, 41, 92].includes(byte) ? '\\' + String.fromCharCode(byte) : String.fromCharCode(byte)
  return 'BT /F1 12 Tf 72 720 Td (' + text + ') Tj ET\n'
}
export function textPdf(pages, options = {}) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R ' + (options.catalogExtra ?? '') + ' >>',
    '<< /Type /Pages /Kids [' + pages.map((_, i) => String(4 + i * 2) + ' 0 R').join(' ') + '] /Count ' + pages.length + ' >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /' + (options.font ?? 'Helvetica') + (options.encoding === null ? '' : ' /Encoding /' + (options.encoding ?? 'WinAnsiEncoding')) + ' ' + (options.fontExtra ?? '') + ' >>',
  ]
  for (const [i, content] of pages.entries()) {
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + (5 + i * 2) + ' 0 R ' + (options.pageExtra ?? '') + ' >>')
    objects.push(stream(content, options))
  }
  return pdf(objects, options)
}

export function xrefStreamTextPdf(pages, options = {}) {
  if (pages.length !== 1) throw new Error('xrefStreamTextPdf fixture supports one page')
  const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets = new Map()
  let offset = chunks[0].length
  const append = (number, body) => {
    offsets.set(number, offset)
    const item = Buffer.concat([Buffer.from(String(number) + ' 0 obj\n'), bytes(body), Buffer.from('\nendobj\n')])
    chunks.push(item)
    offset += item.length
  }
  const catalog = '<< /Type /Catalog /Pages 2 0 R >>'
  const tree = '<< /Type /Pages /Kids [' + pages.map((_, i) => String(4 + i * 2) + ' 0 R').join(' ') + '] /Count ' + pages.length + ' >>'
  const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  const objects = []
  for (const [i, content] of pages.entries()) {
    objects.push(String(4 + i * 2) + ' << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + (5 + i * 2) + ' 0 R >>')
  }
  for (const [i, content] of pages.entries()) append(5 + i * 2, stream(content, options))
  const compressed = [catalog, tree, font, ...objects.map(value => value.slice(value.indexOf(' ') + 1))]
  const names = [1, 2, 3, ...objects.map((_, i) => 4 + i * 2)]
  let payload = ''
  const pairs = []
  for (const [index, value] of compressed.entries()) {
    pairs.push(String(names[index]) + ' ' + Buffer.byteLength(payload))
    payload += value + ' '
  }
  const header = pairs.join(' ') + ' '
  const decoded = Buffer.concat([Buffer.from(header), Buffer.from(payload)])
  append(6, stream(decoded, { deflate: true, extra: '/Type /ObjStm /N ' + names.length + ' /First ' + Buffer.byteLength(header) }))
  const xrefAt = offset
  const row = (kind, first, second) => Buffer.from([
    kind, (first >>> 16) & 255, (first >>> 8) & 255, first & 255, (second >>> 8) & 255, second & 255,
  ])
  const rows = [row(0, 0, 65535)]
  for (let index = 0; index < names.length; index++) rows.push(row(2, 6, index))
  for (let number = 5; number <= 6; number++) rows.push(row(1, offsets.get(number), 0))
  rows.push(row(1, xrefAt, 0))
  let previous = Buffer.alloc(6)
  const predicted = []
  for (const value of rows) {
    predicted.push(2)
    for (let i = 0; i < value.length; i++) predicted.push((value[i] - previous[i]) & 255)
    previous = value
  }
  const packed = deflateSync(Buffer.from(predicted))
  append(7, Buffer.concat([
    Buffer.from('<< /Type /XRef /Size 8 /Root 1 0 R /W [1 3 2] /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 6 >> /Length ' + packed.length + ' >>\nstream\n'),
    packed,
    Buffer.from('\nendstream'),
  ]))
  chunks.push(Buffer.from('startxref\n' + xrefAt + '\n%%EOF\n'))
  return Buffer.concat(chunks)
}
