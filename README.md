<p align="center">
  <img src="docs/assets/readme/dsh-ops-header.svg" alt="dsh-ops 表头" width="640">
</p>

<p align="center">
  <strong>中文</strong> | <a href="README.en.md">English</a>
</p>

<div align="center" style="text-align: center;">
  <a href="https://trendshift.io/repositories/296103" title="Trendshift · JavaScript 日榜">
    <img src="https://trendshift.io/api/badge/trendshift/repositories/296103/daily?language=JavaScript" alt="Trendshift · JavaScript 日榜" width="250" height="55" style="vertical-align: middle;">
  </a>
</div>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-ops"><img alt="npm" src="https://img.shields.io/npm/v/dsh-ops?style=flat-square&color=6c5ce7"></a>
  <a href="https://www.npmjs.com/package/dsh-ops"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-ops?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/T-Auto/dsh-ops/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/T-Auto/dsh-ops?style=flat-square&color=eab308"></a>
  <a href="https://upstar.dev/r/T-Auto/dsh-ops"><img alt="Upstar: #2 in JavaScript" src="https://upstar.dev/badge/T-Auto/dsh-ops.svg"></a>
</p>

# dsh-ops

## 当前集成契约（仅本地，未发布）

Bundle 有**五个独立组件**，只读 TUI 侧栏默认关闭，以下四个默认开启：终端（仅 Windows）、文件、PTC、严格隐藏官方工具。Linux/macOS 默认不激活组件 1，保留官方 `bash`；Windows 提供前台 `ops_bash`，官方命令工具只保留 `pwsh`。组件 3 仅在公开组装结果证实纯 PTC 时发布 `ops_batch` / `ops_result`。

文件 worker 实现十一个有界工具：读取、glob、grep、stat、diff、字面替换、CAS 创建/覆盖、精确编辑、单文件 copy/move/remove。Windows 已有文件覆盖/edit/replace 和 Windows/macOS copy 在无法证明安全元数据保留时返回 `METADATA_UNSUPPORTED`，不会静默降级。未实现目录/递归修改、DOC/PDF、网页/UI、编排替代。当前不注册 `ops_process_*`；不安全的后台进程 lane 已撤回。旧 FastCtx background 入口仅兼容保留，不在五行默认 bundle 内。

**全栈接管被 readiness 阻断，不是已完成能力**：仅官方 read/glob/grep 有已审核映射。官方能力缺少真实替代、OPS 工具缺失、当前作用域官方工具无法隐藏，或保留 transport `run_code` 无法隐藏时，返回 `READINESS_BLOCKED`（执行基础设施问题，非用户权限拒绝）。插件撤销所有自有隐藏限制，保持官方 surface 不变，同时阻止 agent 提示词组装与执行，不允许混用继续。要使用未完整接管的部署，必须由操作者显式关闭整个隐藏组件，不会自动 fallback。当前固定宿主无法隐藏 `run_code`，所以隐藏开启时纯 PTC 也被阻断。

所有操作服从 DSH sandboxPolicy、宿主 subprocess 治理、取消和凭据清理。固定数据式文件操作走可信文件权限围栏及 no-follow/CAS worker，不执行任意代码。提示词按当前作用域实时生成，输出有界；实际实现的回执/分页携带 hash、字节、行数或源计数。详见[组件参考](docs/组件参考.md)、[配置参考](docs/配置参考.md)、[本地 benchmark](docs/benchmark.md)。benchmark token 数仅估算，不代表端到端节省；尚未进行 Desktop GUI 或 POSIX 实机验收。

## 安装、更新、卸载

### 官方插件市场

在目标 DSH 应用的插件市场中输入 npm 包名 **`dsh-ops`**，选择自定义地址，输入 `https://mirrors.huaweicloud.com/repository/npm/`，安装后选择启用。目前不推荐用npmmirror安装，有bug。

当然，如果你确定可以连接 npm 官方源那就选择官方源，如果你不确定那就按教程操作。

![在插件市场中选择自定义地址并填入华为云 npm 镜像](docs/assets/marketplace-huaweicloud-mirror.png)



### npm 一键安装

#### 安装方法

```console
npx --yes dsh-ops@latest install --profile desktop
npx --yes dsh-ops@latest install --profile web
npx --yes dsh-ops@latest install --profile tui
```

必须显式选择目标 profile；`tui` 映射到 **dsh-TUI 产品的 `dsh-tui` profile**，不是旧的 `tui` 目录。请先初始化目标应用。该入口委托官方 DSH CLI 安装，不另写一套 profile 锁与回滚逻辑。

桌面端必须使用桌面应用自带的 CLI；默认探测 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。安装在其它位置时加 `--dsh-cli "<安装目录>\resources\runtime\cli\bin\dsh.cmd"`。Web/TUI 需要可用的 DSH CLI，可同样显式指定。

也可以直接使用官方命令：

```console
dsh plugin --profile web add dsh-ops
dsh plugin --profile dsh-tui add dsh-ops
"<桌面安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-ops
```

普通 DSH CLI 不能管理保留的 `desktop` profile；不要把它与桌面自带入口混淆。

#### 更新方法

重新运行相同的 `npx --yes dsh-ops@latest install --profile ...`，或用官方 CLI `add dsh-ops@latest`。按应用提示重载；替换已加载代码时重启应用。

#### 卸载与查看状态

```console
npx --yes dsh-ops@latest status --profile desktop
npx --yes dsh-ops@latest uninstall --profile desktop
```

把 `desktop` 换成 `web` 或 `tui` 即可。也可在市场卸载，或执行官方 `dsh plugin --profile ... remove dsh-ops`。二进制随 profile 的插件依赖管理；卸载移除依赖引用，不误删系统 shell、其它 profile 的副本或包管理器共享缓存。

旧版显式 provision 的 `<DSH_HOME>/dsh-ops/` 文件（provision 的 shell，以及早期版本可 provision 的 FastCtx 运行时）需单独清理：`npx --yes dsh-ops@latest uninstall --yes`。已移除的后台组件留下的 `~/.fastctx/` 状态默认不删；需要时显式加 `--purge-fastctx`。

原 `dsh-ops/background` 组件（FastCtx 后台任务）已移除。仍保留该行的 profile 照常加载：该行不发布任何工具，只记录一条警告，可直接删除。

## 可选 OPS 只读侧栏

在 dsh-TUI 中启用 `dsh-ops/tui` 行并重启，即可添加 OPS 侧栏；不抢焦点，不执行额外工具调用。没有 `tuiPanels` 的宿主仅让该可选行等待，不影响其它组件。见 [侧栏说明](docs/tui-panel.zh.md)。 聚焦后可用 `f` 筛选、`n`/`p` 本地翻页、`a` 确认跨会话提醒；只浏览有界保留元数据，不拉取结果分页。

## 文档

- [使用指南](docs/使用指南.md) · [常见问题](docs/常见问题.md) · [组件参考](docs/组件参考.md) · [配置参考](docs/配置参考.md)
- [PTC 设计与使用](docs/native-ptc.md) · [手动验证](docs/manual-validation.md)
- [贡献指南](docs/贡献指南.md) · [路线图](docs/roadmap.md) · [变更日志](docs/CHANGELOG.md) · [溯源记录](docs/PROVENANCE.md)

## 许可证

插件源码分发采用 **`MIT AND Apache-2.0`**：`licenses/fastctx/` 之外为 MIT；FastCtx 为 Apache-2.0。见 [NOTICE](NOTICE)、`licenses/fastctx/LICENSE-APACHE` 与 `licenses/fastctx/NOTICE`。

独立的 Windows 载荷包另按上游组件许可证分发：Git for Windows 包含 GPL 等许可组件，PowerShell 包含 MIT 与第三方组件。其原始许可证、声明及来源记录随载荷保留；插件的 MIT 许可不替代这些许可。详见 [PROVENANCE.md](docs/PROVENANCE.md)。

## 致谢

Rust 工具基于 [yc-duan](https://github.com/yc-duan) 的 Codex 插件 FastCtx 并使用其源代码。vendor 标识与删除型分发改动曾记在 `vendor/fastctx/FORK.md` 和 `vendor/fastctx/UPSTREAM.md`，它们保留在仓库历史和早期发布版本中；vendored 源码本身已随后台组件一并移除。需要转载的 FastCtx 声明如下：

> This product includes FastCtx
> (https://github.com/yc-duan/fastctx), Copyright (c) 2026 yc-duan,
> used under the Apache License 2.0.
>
> FastCtx is redistributed and/or modified here by the maintainer of
> this distribution. Any such change is that maintainer's own work
> and their sole responsibility. It is not endorsed by, not
> supported by, and not attributable to the author of FastCtx, who
> accepts no liability of any kind arising from this distribution or
> from anything built on top of it.

## 维护团队

<table>
  <tbody>
    <tr>
      <td align="center" width="150"><a href="https://github.com/T-Auto"><img src="https://github.com/T-Auto.png?size=160" width="96" height="96" alt="T-Auto"></a><br><a href="https://github.com/T-Auto"><b>T-Auto</b></a></td>
      <td align="center" width="150"><a href="https://github.com/ccch1mneyyy"><img src="https://github.com/ccch1mneyyy.png?size=160" width="96" height="96" alt="ccch1mneyyy"></a><br><a href="https://github.com/ccch1mneyyy"><b>ccch1mneyyy</b></a></td>
      <td align="center" width="150"><a href="https://github.com/Haoming9527"><img src="https://github.com/Haoming9527.png?size=160" width="96" height="96" alt="Haoming9527"></a><br><a href="https://github.com/Haoming9527"><b>Haoming9527</b></a></td>
      <td align="center" width="150"><a href="https://github.com/Thatgfsj"><img src="https://github.com/Thatgfsj.png?size=160" width="96" height="96" alt="Thatgfsj"></a><br><a href="https://github.com/Thatgfsj"><b>Thatgfsj</b></a></td>
    </tr>
  </tbody>
</table>

※ 排名不分先后

---

## 贡献者

[![Contributors](https://contrib.rocks/image?repo=T-Auto/dsh-ops)](https://github.com/T-Auto/dsh-ops)

## Star 趋势

[![Star 趋势图](https://api.star-history.com/svg?repos=T-Auto/dsh-ops&type=Date)](https://star-history.com/#T-Auto/dsh-ops&Date)