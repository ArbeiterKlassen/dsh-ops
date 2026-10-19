# Historical platform package skeletons

These directories record the older shell payload package layout. Current releases publish only the main plugin: `describePackages()` returns no shell packages, and the npm manifest declares neither Bash nor PowerShell payload dependencies. The old skeletons and assembly helpers remain for historical provenance and fixture checks.

Bash is now an explicit verified upstream download through `dsh-ops bash-runtime install`. PowerShell stays host-managed; `dsh-ops upgrade-host-pwsh` previews a standard Windows installation and `--yes` executes it. See [usage](../docs/usage.md).

这些目录保留旧 shell 载荷包布局。当前仅发布主插件，不再声明、组装或发布 Bash/PowerShell npm 载荷包；旧骨架与辅助函数仅供历史来源记录及 fixture 检查。Bash 通过显式命令下载，PowerShell 由宿主管理，详见[使用指南](../docs/使用指南.md)。
