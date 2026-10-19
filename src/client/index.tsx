import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import { RUNTIME_REMOTE } from '../settings/runtime-contract.js'
import { en, zh } from './locales.js'
import { ReplacementForm, DiscoveryForm } from './selections.js'
import { ShellForm } from './shell-form.js'
import type { SettingsProps } from './forms.js'
import { SETTINGS_CSS } from './styles.js'
export const name = 'dsh-ops-settings'
export const inject = ['slots', 'locale', 'remote']
export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => ctx.locale.register('dshOps', { en, zh }), 'dsh-ops: settings dictionaries')
  await ctx.remote.$mount(RUNTIME_REMOTE)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshOpsSettings = 'true'; style.textContent = SETTINGS_CSS; document.head.append(style)
    return () => style.remove()
  }, 'dsh-ops: settings styles')
  ctx.slots.inject('plugins.row.config', function* () {
    yield ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-ops#dsh-ops-hide-official', locale: 'dshOps' },
      (props: SettingsProps) => props.view === 'summary' ? <>{props.t('replacements')}</> : <ReplacementForm {...props} />)
    yield ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-ops#dsh-ops-discovery', locale: 'dshOps' },
      (props: SettingsProps) => props.view === 'summary' ? <>{props.t('discovery')}</> : <DiscoveryForm {...props} />)
    yield ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-ops#dsh-ops-shell', locale: 'dshOps' },
      (props: SettingsProps) => props.view === 'summary' ? <>{props.t('shell')}</> : <ShellForm {...props} api={ctx.remote.opsSettings} />)
  })
}
