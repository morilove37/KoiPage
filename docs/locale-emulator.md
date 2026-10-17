# 内置 Locale Emulator

实用工具 → 转区启动，可切换正常启动与日文区域启动。

默认工具是内置 Locale Emulator 2.5.0.1，无需选择外部路径。也可以选择「其他转区工具」，继续使用自选工具。开关和工具选择分别保存在 `locale_tool_use` 与 `locale_tool_source`，自选路径沿用 `locale_tool_path`。

## 运行方式

- 使用用户提供的 `E:\Locale` 运行组件；LEProc.exe、LoaderDll.dll、LocaleEmulator.dll 已与官方 2.5.0.1 下载逐字节核对，LECommonLibrary.dll 来自同一安装目录。
- 组件随 Rust 可执行程序内置，首次需要时释放到应用本地数据目录的 `tools/locale-emulator/2.5.0.1`，运行时不再依赖 E 盘目录。
- 使用独立的日语配置：ja-JP、日文代码页 932、日本时区，默认不要求管理员权限。启动参数通过 `LEProc.exe -runas <profile-guid> <game.exe> <serialized-arguments>` 传递，保留空格、引号、日文和空参数。
- 内置 LE 仅支持 32 位 Windows 游戏；启动前检查 PE 架构，不支持时给出提示并且不创建游玩记录。转区启动仅支持 `.exe`，`.bat`/`.cmd` 启动脚本不支持转区。
- LE 自身会把游戏工作目录设为 exe 所在目录；普通启动继续使用游戏设置中的工作目录。
- LEProc 在游戏退出前保持运行，因此原有时长结算逻辑可以等待它结束。停止转区游戏时结束此工具的进程树，避免只关闭工具而遗留游戏。
- 转区启动开启但工具不存在时显示错误，不会悄悄改为普通启动。

## 第三方资料

组件保持独立且可替换，附带 LGPL / GPL 许可文件和 NOTICE：`src-tauri/resources/locale-emulator`。

- [官方版本及下载](https://github.com/xupefei/Locale-Emulator/releases/tag/v2.5.0.1)
- [LEProc 启动参数与源码](https://github.com/xupefei/Locale-Emulator/blob/v2.5.0.1/LEProc/Program.cs)
- [等待子进程退出的实现](https://github.com/xupefei/Locale-Emulator/blob/v2.5.0.1/LEProc/LoaderWrapper.cs)
- [核心库源码](https://github.com/xupefei/Locale-Emulator-Core)

验证包括组件释放、文件替换、参数转义、PE 架构检查，以及独立 32 位探针的真实 ACP / LCID / 时区、参数和进程生命周期检查。探针验证不启动用户导入的游戏，也不写入真实数据库。
