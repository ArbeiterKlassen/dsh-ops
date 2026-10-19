/** Package defaults only. Saved Loader overrides take precedence over this layer. */
export const COMPONENTS = ['shell', 'file', 'ptc', 'discovery', 'panel', 'tui', 'hide-official'] as const
export type Component = typeof COMPONENTS[number]
export function componentEnabled(component: Component, _platform: string): boolean {
  // The shell row is enabled on every supported platform: on POSIX it resolves the
  // host's bash, on Windows the pinned optional payload.
  return ['shell', 'file', 'ptc', 'discovery'].includes(component)
}
export function componentEntry(component: Component): string { return `dsh-ops/${component}` }
