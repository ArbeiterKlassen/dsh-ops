import { applyComponent } from "../../index.js"
export const name = "dsh-ops-bash & host PowerShell"
export function apply(ctx, config) { return applyComponent(ctx, config, "shell") }
