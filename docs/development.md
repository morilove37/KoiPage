# 开发说明

## 环境

- Windows x64、Node.js 24、项目声明版本的 pnpm。
- Rust stable（edition 2024）、MSVC 构建工具、Windows SDK。
- Microsoft WebView2。

安装依赖后执行 `pnpm tauri dev`，前端 Vite 固定使用 1420 端口。启动前避免占用该端口。

## 验证

```bash
pnpm build
pnpm check:ipc
pnpm check:release
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
```

部分测试会访问外部数据源，默认忽略；手动运行联网测试会消耗数据源配额。

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib live_tests -- --ignored --nocapture --test-threads=1
```

## 目录

| 目录 | 内容 |
|---|---|
| `src/components/ui` | 基础界面组件 |
| `src/features/home` | 首页与游玩概览 |
| `src/features/library` | 游戏库与批量导入 |
| `src/features/detail` | 游戏详情、标签与历史 |
| `src/features/metadata` | 资料匹配与确认 |
| `src/features/settings` | 设置与滚动导航 |
| `src/features/updates` | 更新提示与设置 |
| `src/lib` | 数据桥接、主题、离线标签词典与更新状态 |
| `src-tauri/src/commands` | SQLite 数据命令 |
| `src-tauri/src/scanner` | 游戏目录与 exe 识别 |
| `src-tauri/src/launcher` | 游戏进程、时长与数据导入导出 |
| `src-tauri/src/metadata` | NextMoe、VNDB、Bangumi 接入 |
| `src-tauri/migrations` | 数据库迁移 |

## 数据迁移与图片

已发布的迁移文件只保留向上迁移语句，不修改已应用迁移的内容；新增结构时增加新迁移。

本地封面和壁纸通过 asset 协议读取。静态授权范围保持为空，运行时只授予所需文件的读取权限。壁纸显示与设置控件均受液态玻璃主题限制。

不要改变 `com.galgame.manager` 应用标识或 MSI UpgradeCode，否则可能改变数据位置或升级行为。

## 真实窗口验证

`scripts/cdp-eval.mjs` 与 `scripts/cdp-shot.mjs` 通过 WebView2 调试协议读取界面，用于开发验证。只在需要验证时开放本机调试端口。

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
.\src-tauri\target\debug\galgame-manager.exe
node scripts/cdp-eval.mjs 'document.title'
node scripts/cdp-shot.mjs screenshot.png
```

开发版可以检查更新，但不通过应用内安装覆盖开发目录；安装更新使用 GitHub 发布版。

## 编译缓存与发布文件

`node_modules`、`dist`、`src-tauri/target` 均不提交。Rust 编译缓存可能达到数 GB，实际安装包大小以 Release 附件为准。

日常界面修改使用热更新，Rust 修改使用开发构建；仅在准备发布版本时生成安装包。签名发布参见 [发布流程](publishing.md)。
