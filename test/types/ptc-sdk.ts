import type { OpsSdk, Outcome, StorageReference } from 'dsh-ops/ptc-sdk'

declare const tools: OpsSdk
async function read() {
  const result = await tools.ops_read_many({ files: [{ path: 'a.ts', offset: 1, limit: 20 }] })
  // @ts-expect-error A result must be narrowed before accessing failure details.
  void result.error
  if (result.status === 'completed') {
    const text: string | undefined = result.data.items?.[0]?.items?.[0]?.text
    // @ts-expect-error Canonical text is not a number.
    const count: number = result.data.items?.[0]?.items?.[0]?.text
    return text
  }
  if (result.status === 'partial') {
    const complete: false = result.coverage.isComplete
    const next: string = result.continuation
    // @ts-expect-error Partial is an explicit continuation state, not a failure.
    void result.error
    return { complete, next }
  }
  const retry: 'never' | 'after-input-change' | 'after-state-change' | 'bounded-transient' = result.error.retry
  return { code: result.error.code, retry }
}
async function metadata() {
  const result = await tools.ops_stat({ path: 'a.ts' })
  if (result.status === 'completed') {
    const modified: number | null | undefined = result.data.modifiedMs
    return modified
  }
}
void tools.ops_inspect_local_file({ path: 'a.ts', view: 'hex' })
// @ts-expect-error Tool arguments preserve the original enum contract.
void tools.ops_inspect_local_file({ path: 'a.ts', view: 'pdf' })
// @ts-expect-error Multi-read requires a list of file ranges.
void tools.ops_read_many({ path: 'a.ts' })
// @ts-expect-error Editing requires the observed revision.
void tools.ops_edit_many({ path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] })
// @ts-expect-error Tool names are a finite catalogue, not an open arbitrary dictionary.
void tools.ops_unknown_tool({})
const completed: Outcome<StorageReference | undefined> = { status: 'completed', data: undefined }
void [read, metadata, completed]

async function tables() {
  const result = await tools.ops_table_read({ path: 'rows.csv', header: false, encoding: 'utf-16le' })
  if (result.status === 'completed' || result.status === 'partial') {
    const cells: string[] | undefined = result.data.items?.[0]?.cells
    const rows: number | undefined = result.data.source?.rowsObserved
    // @ts-expect-error Cells preserve lexical text instead of guessing numbers.
    const numeric: number[] | undefined = result.data.items?.[0]?.cells
    return { cells, rows }
  }
  return result.data?.items?.[0]?.cells
}
// @ts-expect-error Encoding is a finite strict-decoding contract.
void tools.ops_table_read({ path: 'rows.csv', encoding: 'latin1' })
void tables

async function paragraphs() {
  const value = await tools.ops_doc_read({ path: 'body.docx', offset: 1, limit: 10 })
  if (value.status === 'completed' || value.status === 'partial') {
    const text: string | undefined = value.data.items?.[0]?.text
    const kind: 'paragraph' | undefined = value.data.items?.[0]?.type
    const scope: string | undefined = value.data.scope
    // @ts-expect-error Document paragraphs are not table cell arrays.
    void value.data.items?.[0]?.cells
    return { text, kind, scope }
  }
  return value.data?.items?.[0]?.text
}
// @ts-expect-error DOCX decoding comes from the package, not a caller-supplied encoding.
void tools.ops_doc_read({ path: 'body.docx', encoding: 'utf-8' })
void paragraphs
