import type { Context } from '../adapter/dsh/types.js'
import { ownScopes } from '../scoped-ownership.js'
export const ownPtcScopes = (ctx: Context, changed: () => void) => ownScopes(ctx, 'ptc', changed)
