import type { RuntimeRemote } from '../settings/runtime-contract.js'
import { FormActions, Unavailable, useEditor } from './forms.js'
import type { SettingsProps } from './forms.js'
import { RuntimePanel } from './runtime-panel.js'
const readShell = (value: Record<string, unknown>) => ({ path: typeof value.bashPath === 'string' ? value.bashPath : '', enabled: value.publishBashTool !== false })
export function ShellForm(props: SettingsProps & { api: RuntimeRemote }) {
  const { form, t, api } = props, editor = useEditor(form, readShell, t)
  return <div className="ops-settings">
    {editor.ready ? <form className="ops-settings" onSubmit={event => { event.preventDefault(); void editor.save([
      editor.draft.path.trim() ? { op: 'set', path: ['bashPath'], value: editor.draft.path } : { op: 'unset', path: ['bashPath'] },
      { op: 'set', path: ['publishBashTool'], value: editor.draft.enabled },
    ]) }}>
      <label className="ops-settings-choice"><input type="checkbox" checked={editor.draft.enabled} disabled={editor.busy}
        onChange={event => editor.edit({ ...editor.draft, enabled: event.target.checked })} />{t('publishBash')}</label>
      <label className="ops-settings-field">{t('bashPath')}<input type="text" value={editor.draft.path} disabled={editor.busy}
        onChange={event => editor.edit({ ...editor.draft, path: event.target.value })} /></label>
      <p className="ops-settings-note">{t('bashHint')}</p><FormActions {...editor} t={t} />
    </form> : <Unavailable {...props} />}
    <RuntimePanel api={api} t={t} editable={editor.ready && !editor.busy} onSelect={path => editor.edit({ ...editor.draft, path })} />
  </div>
}
