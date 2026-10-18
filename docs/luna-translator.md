# 内置 LunaTranslator 游戏翻译

实用工具 → 游戏翻译，内置官方 **LunaTranslator v12.1.2.9 x64**，首次进入时释放到可写的本地应用数据目录，安装后无需另行下载即可启动。

## 使用

- 「启动 Luna」以普通权限启动 `LunaTranslator.exe`，工作目录为程序自身目录。文本提取（HOOK / OCR）、游戏绑定、翻译引擎、密钥和其他设置都由 Luna 自身管理。
- 显示就绪及运行状态，支持重新检查、打开程序目录和官方使用教程。只识别内置程序的完整路径，不把其他目录中的同名进程当成当前内置实例，不强制退出用户的翻译器。
- 「退出 Luna」向这份内置程序的 Qt 窗口发送正常关闭请求，沿用 Luna 保存配置并退出的流程；确认进程结束后更新状态。没有运行时按钮禁用，退出未完成或权限不足时提示从 Luna 自身的托盘菜单退出，不强杀进程，也不关闭其他目录的 Luna。
- 「随游戏启动」默认关闭，保存在 `luna_autostart`。开启后，恋页在启动游戏时先尝试打开 Luna；它只负责启动程序，不自动选择 HOOK 或替用户设置翻译接口。Luna 不可用时游戏仍正常启动，开关在组件准备失败时也能关闭。
- 内置程序可离线启动；在线翻译接口需要网络，离线翻译需在 Luna 中自行配置本地引擎。

## 存储与更新

程序位于 `%LOCALAPPDATA%\com.galgame.manager\tools\luna\12.1.2.9\LunaTranslator_x64`，`userconfig`、缓存和 Luna 自更新文件均留在可写目录。

首次准备时使用已有内置 7-Zip 将原始 ZIP 解压至任务专属临时目录，通过完整解压结果检查后，以临时文件加重命名的方式发布文件，最后才写入就绪标记。准备中断可重试，不会把半写入文件视为已安装。已有成功部署再次修复时仅补缺失/空文件，保留设置和自更新。

内置 ZIP 为 **66,657,834 字节**（约 63.6 MiB），完整源码 ZIP 为 **3,887,383 字节**（约 3.7 MiB），程序释放后约 139.5 MiB；会增加应用和之后安装包的体积。第一次释放期间还需要原始 ZIP、临时解压目录的空间，成功后会清理这些任务临时文件。

## 作者许可与来源

2026-10-18 核实的官方仓库 [HIllya51/LunaTranslator](https://github.com/HIllya51/LunaTranslator) 和 [官方许可](https://github.com/HIllya51/LunaTranslator/blob/5a11c55e2cc8c0095a77f9f2145eb01bd6cfc410/LICENSE) 指定 **GNU GPL version 3**。本次接入依据公开许可，未声称获得作者私人背书。

- 官方发布：[v12.1.2.9](https://github.com/HIllya51/LunaTranslator/releases/tag/v12.1.2.9)，`LunaTranslator_x64.zip` 原样内置。
- 原包 SHA-256：`1d8a2fd8ec0aade868471e0976491d2e97888d38f14d909f0e7628b9442410a3`，与 GitHub release asset 公布的 digest 一致。
- 对应源码 commit：`5a11c55e2cc8c0095a77f9f2145eb01bd6cfc410`；[源码树](https://github.com/HIllya51/LunaTranslator/tree/5a11c55e2cc8c0095a77f9f2145eb01bd6cfc410)及[源码 ZIP](https://codeload.github.com/HIllya51/LunaTranslator/zip/5a11c55e2cc8c0095a77f9f2145eb01bd6cfc410)。源码含构建脚本和依赖来源，无 git submodule 缺失。
- 源码 ZIP SHA-256：`d8558207a31cebab9ab0d985698ad86a86e451b3e1c85a45aceca5cf6b96ac06`。
- 内置资源：`src-tauri/resources/luna/` 下的原包、源码、LICENSE、NOTICE.txt、manifest.json。原包中的 `LICENSES/` 全部保留；程序由 HIllya51 与相关贡献者维护，第三方组件遵循各自许可。
- 恋页通过独立进程启动未修改的程序，不链接 Luna 的代码，不更改其作者署名、品牌、许可或设置。公开分发后续版本时继续同时提供本版本的许可、源码和声明，不单独删除源码资源。
- 工具页「查看许可」「对应版本源码」可访问本地随包文件；「作者项目」「官方下载与帮助」指向官方。源码与许可的固定内置副本会校验内容并原子修复，避免中断后留下不完整文件。

## 开发验证

```powershell
cargo test --manifest-path src-tauri/Cargo.toml luna --lib --locked
pnpm build
pnpm check:ipc
```

测试覆盖二进制/源码 SHA-256、离线部署、配置与自更新保留、截断文件恢复、关键入口补齐和启动工作目录。隔离浏览器覆盖准备失败重试、失败时关闭自动启动、启动状态、源码/许可入口、三种主题和 1280/960 宽度。日常改动使用开发版验证，不自动生成安装包。
