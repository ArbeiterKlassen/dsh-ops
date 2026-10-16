<p align="center">
  <img src="docs/assets/readme/dsh-ops-header.svg" alt="dsh-ops 表头" width="640">
</p>

<p align="center">
  <strong>中文</strong> | <a href="README.md">English</a>
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

致力优化dsh插件token效率，提升ai性能，减少token消耗，减少任务总时间的插件，解决 Windows 下 DSH 反复使用 PowerShell 报错造成的 token、时间和模型注意力浪费，会持续更新。

本插件的主要功能：

- 提供一组更高级的tools常驻工具，由rust编写。这些tools工具相对于原版，输入和输出token都更少，运行速度更快，且覆盖面更广，给ai造成的心智负担更低，同时附带简短的哈希校验、行数位置等消息以减少
- 以渐进式纰漏的形式，为日常工作提供诸如doc/pdf操作，网页搜索，html转markdown类crawl4ai工具等日常工作常用的tools工具。这些工具可以使得ai不必重新编写代码或者脚本来实现自己的目标从而大大节省Token
- 提供关闭原版tools以最大化节省ai心智负担和系统固定提示词的可选项
- 在windows平台下额外提供tools：ops_bash的支持——ai使用bash远比ai使用pwsh更流畅。可选择使用ops自带的独立 **bash 5.3.15** ，也可以将ops_bash工具指定为git bash

> tips：本项目的 ops 是广义 operations （运行操作）的缩写，代指本插件处于dsh和系统/代码/文件操作的基础工具位置。本项目不是 operations（运维）插件。

## 安装、更新、卸载
