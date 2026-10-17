# Magpie 窗口缩放

实用工具 → 窗口缩放，默认使用内置 Magpie 0.12.1，无需另装；也可以切换为「其他 Magpie 程序」。

Magpie 是第三方窗口缩放工具，用于把游戏窗口放大到全屏或更大尺寸。恋页负责选择来源、启动与退出，缩放效果和画面参数仍由 Magpie 自身控制，快捷键也由 Magpie 响应。

## 内置 Magpie

- 内置官方 Magpie v0.12.1（x64）发布包，随应用分发；首次使用时释放到应用本地数据目录的 `tools/magpie/0.12.1`（即 `%LOCALAPPDATA%\com.galgame.manager\tools\magpie\0.12.1`），之后离线可用。
- 释放目录包含 `Magpie.exe`、`Microsoft.UI.Xaml.dll`、`resources.pri`、`TouchHelper.exe`、`Updater.exe`、`effects/` 以及 `COPYING`、`NOTICE.txt`；不包含 cache 与 logs，运行时自行生成。
- 内置 Magpie 以非便携模式运行，配置仍读写 `%LOCALAPPDATA%\Magpie\config\vN\config.json`，快捷键显示与外部 Magpie 共用同一份配置。
- 内置资源约 29 MB（官方 zip 约 10.3 MB），会增大安装包体积。
- 随包附带一份开发者调校的默认缩放配置（`src-tauri/resources/magpie-defaults/config.json`，含完整的缩放模式与默认选择）。本机还没有 Magpie 配置时，界面会展示并在首次启动 / 首次选择模式时写入这份默认配置；**已有配置永远不会被覆盖**。
- 来源与开关保存在设置里：`magpie_source` 为 `bundled`（默认，内置）或 `custom`（其他 Magpie 程序），`magpie_path` 保存外部程序路径，`magpie_autostart` 控制随游戏启动。

## 其他 Magpie 程序

- 选择「其他 Magpie 程序」后，可手动选择 `Magpie.exe`，路径保存在 `magpie_path`。
- 自动检测：优先读取正在运行的 Magpie 进程路径；没有运行中的 Magpie 时，依次检查常见安装位置，例如 `%LOCALAPPDATA%\Programs\Magpie`、`%ProgramFiles%\Magpie`。
- 检测不到或路径失效时，状态区会提示未找到 Magpie，需要重新选择或切回内置。

## 版本与快捷键

- 页面显示当前 Magpie 版本；内置与外部 Magpie 的快捷键都从 Magpie 配置读取，默认是 **Win+Shift+A**。
- 配置位置：优先 Magpie.exe 同级的 `config\vN\config.json`（便携版），否则 `%LOCALAPPDATA%\Magpie\config\v4\config.json`；读取其中的 `shortcuts.scale`。
- 快捷键只做展示，实际按键由 Magpie 处理；修改快捷键请在 Magpie 内进行，重新进入页面即可看到更新后的值。

## 缩放算法与滤镜

- 窗口缩放卡片里的「缩放算法与滤镜」可选择**默认缩放模式**；模式列表与效果链默认来自本机 Magpie 配置（`config.json` 的 `scalingModes`）。本机还没有配置时展示应用内置的默认配置（开发者调校：包含 `1k` 等调好的模式，默认选择 `1k`），其他用户下载后也使用这套默认值。
- 选择保存在 `magpie_scaling_mode`。Magpie **未运行**时会立即写入本机配置并提示已应用；Magpie **正在运行**时只保存，等下次启动 Magpie 时自动应用，且不会覆盖 Magpie 正在使用的配置。
- 写入前会备份一份 `config.koipage-backup.json`，只修改默认配置的 `profiles[0].scalingMode`，其余字段保持不变。
- 「恢复内置默认」按钮：把本机 Magpie 配置整体替换为随包分发的默认配置（开发者调校），并清除恋页里保存的默认模式选择；原配置会先备份为 `config.koipage-before-reset.json`，可手动还原。Magpie 正在运行时该按钮不可用，需先退出 Magpie。

## 随游戏启动

- 开启「随游戏启动」（`magpie_autostart`）后，恋页会在启动游戏前检查 Magpie 是否在运行；没有运行则先启动 Magpie。它**只保证 Magpie 在运行，不会替你按下缩放快捷键**。

## 启动与退出

- 在页面中可以直接启动或退出 Magpie。
- 退出可能失败：如果 Magpie 以管理员权限运行，请在其托盘菜单中选择退出。

## 第三方与许可

- 内置 Magpie 来自官方发布包 [Magpie v0.12.1](https://github.com/Blinue/Magpie/releases/tag/v0.12.1)（`Magpie-v0.12.1-x64.zip`），SHA-256 为 `8bc8bc233438f546b7996b00b21d7376f4f7d3d8a4940e6a8800babd2225b2de`。
- Magpie 以 **GPL-3.0** 许可分发。许可与来源说明随组件提供：`src-tauri/resources/magpie/COPYING`、`NOTICE.txt`；构建时嵌入应用，首次使用时释放到上述目录。
- 对应源码：[Magpie v0.12.1 源码](https://github.com/Blinue/Magpie/tree/v0.12.1)。
- 恋页以独立进程方式调用 `Magpie.exe`，未修改其二进制；Magpie 由其原作者维护。

## 下载

- [下载最新版 Magpie](https://github.com/Blinue/Magpie/releases/latest)
- [项目主页](https://github.com/Blinue/Magpie)
