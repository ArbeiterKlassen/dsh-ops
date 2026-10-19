/** Package defaults only. Saved Loader overrides take precedence over this layer. */
export const COMPONENTS = ['shell', 'file', 'ptc', 'discovery', 'panel', 'tui', 'hide-official'] as const
export type Component = typeof COMPONENTS[number]
export const SHELL_DISABLED_EXPRESSION = "process.platform !== 'win32'"
export function componentEnabled(component: Component, platform: string): boolean {
  return component === 'shell' ? platform === 'win32' : ['file', 'ptc', 'discovery'].includes(component)
}
export function componentEntry(component: Component): string { return `dsh-ops/${component}` }
