<p align="center">
  <img src="docs/assets/readme/dsh-ops-header.svg" alt="dsh-ops header" width="640">
</p>

<p align="center">
  <strong>English</strong> | <a href="README.zh.md">简体中文</a>
</p>

<div align="center" style="text-align: center;">
  <a href="https://trendshift.io/repositories/296103" title="Trendshift · JavaScript daily list">
    <img src="https://trendshift.io/api/badge/trendshift/repositories/296103/daily?language=JavaScript" alt="Trendshift · JavaScript daily list" width="250" height="55" style="vertical-align: middle;">
  </a>
</div>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-ops"><img alt="npm" src="https://img.shields.io/npm/v/dsh-ops?style=flat-square&color=6c5ce7"></a>
  <a href="https://www.npmjs.com/package/dsh-ops"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-ops?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/T-Auto/dsh-ops/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/T-Auto/dsh-ops?style=flat-square&color=eab308"></a>
  <a href="https://upstar.dev/r/T-Auto/dsh-ops"><img alt="Upstar: #2 in JavaScript" src="https://upstar.dev/badge/T-Auto/dsh-ops.svg"></a>
</p>

# dsh-ops

A plugin dedicated to improving the token efficiency of DSH plugins, boosting AI performance, reducing token consumption, and cutting total task time. It removes the token, time, and model-attention waste caused by DSH repeatedly hitting PowerShell errors on Windows, and will keep being updated.

Main features of this plugin:

- A set of more advanced always-on tools written in Rust. Compared with the built-ins, these tools use fewer input and output tokens, run faster, cover more ground, and impose less mental load on the AI; they also carry brief hash checks, line/position info, and similar messages to reduce token overhead.
- Through progressive disclosure, it provides everyday tools such as DOC/PDF operations, web search, and crawl4ai-style HTML-to-Markdown tools. These save a lot of tokens by letting the AI avoid writing one-off code or scripts to reach its goal.
- Provides an option to disable the built-in tools, to maximize savings on the AI's mental load and the fixed system prompt.
- On Windows it additionally provides the `ops_bash` tool — the AI is far more fluent with bash than with pwsh. You can use the independent **bash 5.3.15** bundled with ops, or point the `ops_bash` tool at Git Bash.

> tips: "ops" here is short for the broad sense of operations (running operations), indicating that this plugin sits in the base-tool position between DSH and system/code/file operations. This is not an operations (ops/SRE) plugin.

## Install, update and uninstall
