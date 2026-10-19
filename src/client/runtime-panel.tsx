import { useEffect, useRef, useState } from 'react'
import type { RuntimeAction, RuntimePlan, RuntimeRemote, RuntimeResult, RuntimeSnapshot, BashSource } from '../settings/runtime-contract.js'
import type { Translator } from './locales.js'
import { errorText } from './forms.js'
const executeLabel = { 'install-bash': 'install', 'remove-bash': 'remove', 'upgrade-pwsh': 'upgrade' } as const
export function RuntimePanel({ api, t, onSelect, editable }: { api: RuntimeRemote; t: Translator; onSelect(path: string): void; editable: boolean }) {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(), [plan, setPlan] = useState<RuntimePlan>()
  const [result, setResult] = useState<RuntimeResult>(), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const cancellation = useRef<AbortController>(), mounted = useRef(true), refreshEpoch = useRef(0)
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; cancellation.current?.abort() } }, [api])
  async function refresh(clearMessage = true) {
    const epoch = ++refreshEpoch.current
    try { const response = await api.snapshot(); if (!mounted.current || epoch !== refreshEpoch.current) return
      if (response.ok) { setSnapshot(response.value); if (clearMessage) setMessage('') }
      else { setSnapshot(undefined); setMessage(response.error.message) }
    } catch (error) { if (mounted.current && epoch === refreshEpoch.current) setMessage(errorText(error)) }
  }
  async function preview(action: RuntimeAction) {
    setBusy(true); setMessage(''); setResult(undefined); setPlan(undefined)
    try { const response = await api.plan(action); if (!mounted.current) return
      if (response.ok) setPlan(response.value); else setMessage(response.error.message)
    } catch (error) { if (mounted.current) setMessage(errorText(error)) }
    finally { if (mounted.current) setBusy(false) }
  }
  async function select(source: BashSource) {
    setBusy(true); setMessage('')
    try { const response = await api.select(source); if (!mounted.current) return
      if (response.ok) { onSelect(response.value.bashPath); setMessage(`${t('selectionHint')} ${response.value.restriction}`) }
      else setMessage(response.error.message)
    } catch (error) { if (mounted.current) setMessage(errorText(error)) }
    finally { if (mounted.current) setBusy(false) }
  }
  async function execute() {
    if (!plan?.available || busy) return
    const controller = new AbortController(); cancellation.current = controller; setBusy(true); setMessage('')
    try { const response = await api.execute(plan.id, controller.signal); if (!mounted.current) return
      if (response.ok) setResult(response.value)
      else setResult({ status: controller.signal.aborted ? 'cancelled' : 'failed', effectState: 'unknown', message: response.error.message })
      setPlan(undefined)
      await refresh(false)
    } catch (error) { if (mounted.current) setResult({ status: controller.signal.aborted ? 'cancelled' : 'failed', effectState: 'unknown', message: errorText(error) }) }
    finally { cancellation.current = undefined; if (mounted.current) { setPlan(undefined); setBusy(false) } }
  }
  return <section className="ops-settings ops-settings-runtime" aria-label={t('runtime')}>
    <h3>{t('runtime')}</h3><p>{t('runtimeHelp')}</p>
    {!snapshot && <p role="status">{t('noRuntime')}</p>}
    {snapshot && <p>{t('managedCount')}: {snapshot.managed.filter(entry => entry.owned).length}; {t('gitCount')}: {snapshot.git.length}</p>}
    <div className="ops-settings-actions">
      <button type="button" disabled={busy} onClick={() => void refresh()}>{t('refresh')}</button>
      <button type="button" disabled={busy || !editable || !snapshot?.managed.some(entry => entry.owned)} onClick={() => void select('managed')}>{t('managed')}</button>
      <button type="button" disabled={busy || !editable || !snapshot?.git.length} onClick={() => void select('git')}>{t('git')}</button>
    </div>
    <div className="ops-settings-actions">
      <button type="button" disabled={busy || !snapshot || snapshot.platform !== 'win32'} onClick={() => void preview('install-bash')}>{t('previewInstall')}</button>
      <button type="button" disabled={busy || !snapshot?.managed.some(entry => entry.owned)} onClick={() => void preview('remove-bash')}>{t('previewRemove')}</button>
    </div><p>{t('pwshHelp')}</p>
    <div className="ops-settings-actions"><button type="button" disabled={busy || !snapshot?.powerShell.supported} onClick={() => void preview('upgrade-pwsh')}>{t('previewPwsh')}</button></div>
    {snapshot?.powerShell.unavailable && <p className="ops-settings-note">{snapshot.powerShell.unavailable}</p>}
    {plan && <div className="ops-settings-preview" role="region" aria-label={t('preview')}>
      <h3>{t(executeLabel[plan.action])}</h3><ul>{plan.details.map((line, index) => <li key={index}>{line}</li>)}</ul>
      {plan.reason && <p role="status">{plan.reason}</p>}
      <div className="ops-settings-actions"><button type="button" className="ops-settings-primary" disabled={!plan.available || busy} onClick={() => void execute()}>{t(executeLabel[plan.action])}</button>
        <button type="button" disabled={busy} onClick={() => setPlan(undefined)}>{t('dismiss')}</button></div>
    </div>}
    {busy && <p role="status">{t('busy')}</p>}
    {busy && cancellation.current && <button type="button" onClick={() => cancellation.current?.abort()}>{t('cancel')}</button>}
    {result && <div role="status"><p>{result.message}</p>{result.exitCode !== undefined && <p>{t('exitCode')}: {result.exitCode ?? '—'}</p>}
      {result.effectState === 'unknown' && <p>{t('unknownEffect')}</p>}</div>}
    {message && <p role="status">{message}</p>}
  </section>
}
