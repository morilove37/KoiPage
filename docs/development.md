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
| `src/features/tools` | 实用工具（转区启动与窗口缩放） |
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

## 内置第三方组件

- `src-tauri/resources/locale-emulator`：内置 Locale Emulator，由 `launcher/locale.rs` 的 `include_bytes!` 清单直接内嵌。
- `src-tauri/resources/magpie`：官方 Magpie 发布包（GPL-3.0，含 `COPYING`、`NOTICE.txt`）。`build.rs` 递归生成内嵌清单，首次使用时由 `launcher/magpie.rs` 解压到应用本地数据目录的 `tools/magpie/<版本>`；`.gitignore` 对这里的 `*.exe` 有白名单，新增二进制后确认 `git status` 能看到。
- `src-tauri/resources/magpie-defaults/config.json`：随包分发的默认缩放配置（开发者调校的 `scalingModes` 与默认选择）。本机没有 Magpie 配置时由 `launcher/magpie.rs` 写入 `%LOCALAPPDATA%\Magpie\config\v4\config.json`；已有配置不会被覆盖。调整默认值后替换该文件即可，`cargo test --lib` 会校验它能被解析且包含缩放模式。
- `src-tauri/resources/7zip`：官方 7-Zip 26.01 控制台组件（`7z.exe` + `7z.dll`，LGPL + unRAR restriction，含 `License.txt`、`NOTICE.txt`）。`build.rs` 生成 `sevenzip_files.rs`，首次解压时由 `extract/mod.rs` 释放到应用本地数据目录的 `tools/7zip/<版本>`；`.gitignore` 对 `7z.exe` 有白名单。升级时替换这两个文件并同步 `BUNDLED_VERSION`。
- 升级内置 Magpie：替换 `src-tauri/resources/magpie` 的内容并同步 `NOTICE.txt`，修改 `launcher/magpie.rs` 的 `BUNDLED_VERSION`，再更新 `docs/magpie.md` 与 README 中的版本与 SHA-256。`cargo test --lib` 会校验内嵌资源完整性、解压幂等和内置版本号。

## 真实窗口验证

首页角色生日的数据结构、同步行为和验证命令见 [角色生日](character-birthdays.md)。
内置游戏翻译的固定版本、GPL 许可与源码交付、准备/修复策略见 [LunaTranslator](luna-translator.md)。

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
