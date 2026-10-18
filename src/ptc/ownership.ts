import type { Context } from '@deepseek-ai/cordis'
import { ownScopes } from '../scoped-ownership.js'
export const ownPtcScopes = (ctx: Context, changed: () => void) => ownScopes(ctx, 'ptc', changed)
