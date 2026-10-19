/** Document schemas describe their bounded observation scope; registration remains catalogue-owned. */
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { ParameterSchema } from './types.js'
import { STORAGE_REFERENCE } from './result.js'
const string: JsonSchemaNode = { type: 'string' }
const integer: JsonSchemaNode = { type: 'integer' }
const boolean: JsonSchemaNode = { type: 'boolean' }
const strings: JsonSchemaNode = { type: 'array', items: string }
const object = (properties: Record<string, JsonSchemaNode>, required: string[] = []): ParameterSchema => ({ type: 'object', properties, required, additionalProperties: false })
export const DOCUMENT_PARAMETERS = Object.freeze({
  table_read: object({
    path: { ...string, description: 'Regular file path relative to the current session cwd.' },
    format: { type: 'string', enum: ['csv', 'tsv'], description: 'Default tsv for .tsv paths, otherwise csv.' },
    encoding: { type: 'string', enum: ['utf-8', 'utf-16le', 'utf-16be'], default: 'utf-8', description: 'Strict decoding; conflicting BOMs fail. No replacement characters.' },
    header: { type: 'boolean', default: true, description: 'First record is columns when true; empty/duplicate column names stay positional.' },
    offset: { type: 'integer', default: 1, description: '1-100000 data rows, 1-based; header is excluded.' },
    limit: { type: 'integer', default: 200, description: '1-1000 data rows.' },
  }, ['path']),
})
export const DOCUMENT_DESCRIPTIONS = Object.freeze({
  table_read: 'Read bounded CSV/TSV lexical string cells relative to session cwd. Preserves quoted multiline records and physical LF lineStart/lineEnd. Check scanComplete versus pageComplete; total/revision exist only after a stable full scan. Up to 32 MiB, 100000 data records, 1 MiB/record, 1024 columns and 30s; row paging cannot bypass scan gaps. Errors retain safe preceding rows with nextAction. Compare revisions before combining rescanned pages. No spreadsheet formulas or type coercion. Failures return status:error|rejected and error.code; never throw.',
})
export const DOCUMENT_FACTS: Record<string, JsonSchemaNode> = {
    format: string, encoding: string, header: boolean, columns: strings, columnCount: integer,
    bytes: integer, bytesRead: integer, rowsObserved: integer, skipped: integer,
    scanComplete: boolean, pageComplete: boolean, complete: boolean, truncated: boolean,
    truncatedBy: string, nextOffset: integer, total: integer, rowCount: integer, omitted: integer, revision: string,
}
export const DOCUMENT_SOURCE: JsonSchemaNode = { type: 'object', properties: { ...DOCUMENT_FACTS, root: string,
  itemEncoding: string, capturedItems: integer, captureComplete: boolean } }
export const DOCUMENT_OUTPUT: JsonSchemaNode = {
  type: 'object', properties: {
    ...DOCUMENT_FACTS, status: string, phase: string, changed: integer, effectState: string, path: string,
    items: { type: 'array', items: object({ row: integer, cells: strings, lineStart: integer, lineEnd: integer }, ['row', 'cells', 'lineStart', 'lineEnd']) },
    error: { type: 'object' }, nextAction: string, reference: STORAGE_REFERENCE, referenceRoot: string,
    source: DOCUMENT_SOURCE, storageError: { type: 'object' },
  },
}
export function isDocumentTool(tool: string): tool is keyof typeof DOCUMENT_PARAMETERS { return Object.hasOwn(DOCUMENT_PARAMETERS, tool) }
export function documentOutput(tool: string): JsonSchemaNode | undefined { return isDocumentTool(tool) ? DOCUMENT_OUTPUT : undefined }
