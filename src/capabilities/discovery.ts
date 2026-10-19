import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { ParameterSchema } from './types.js'

/** Reviewed, currently implemented advanced operations. Future formats are absent. */
export const DISCOVERY_TERMS = Object.freeze({
  pdf_read: 'pdf portable document pages text extraction font',
  doc_read: 'docx word document paragraphs body text tables zip xml unicode',
  table_read: 'table csv tsv delimiter quoted records columns rows encoding utf16',
  inspect_local_file: 'read inspect single file text hex binary bounded line windows',
  edit_many: 'edit patch multiple files atomic per file revision cas',
  result: 'result reference page release stored output continuation',
  glob: 'glob find search file paths patterns',
  grep: 'grep search content regex matching text count summary',
  replace: 'batch literal text replacement across files',
  write_file: 'write create overwrite full file content atomic revision cas',
  edit_file: 'edit patch unique text atomic revision cas',
  diff: 'diff preview compare proposed file content',
  stat: 'stat metadata revision hash bytes size line count',
  copy: 'copy duplicate file no clobber revision',
  move: 'move rename file no clobber revision',
  remove: 'remove delete unlink file revision',
})
export const DISCOVERY_PARAMETERS: ParameterSchema = {
  type: 'object', additionalProperties: false, required: ['query'],
  properties: {
    query: { type: 'string', description: 'Capability or select:ops_name; 1-512 characters.' },
    max_results: { type: 'integer', default: 3, description: '1-5; default 3, capped by config.' },
  },
}
export const DISCOVERY_DESCRIPTION = 'Select allowed OPS capabilities for the next model step in this scope; no file action.'
export const DISCOVERY_OUTPUT: JsonSchemaNode = {
  type: 'object', properties: {
    status: { type: 'string' }, activated: { type: 'array', items: { type: 'string' } },
    alreadyActive: { type: 'array', items: { type: 'string' } }, message: { type: 'string' },
    error: { type: 'object' },
  },
}
