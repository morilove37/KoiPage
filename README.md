<div align="center">
  <img src="public/brand/koipage.png" width="104" height="104" alt="恋页 KoiPage 图标" />

  <h1>恋页 KoiPage</h1>
  <p><strong>收藏相遇，续写下一页。</strong></p>
  <p>把散落在磁盘里的 Galgame 和视觉小说，整理成自己的收藏。</p>
  <p>Windows x64 · 本地游戏库 · 资料匹配 · 游玩记录</p>

  <a href="https://github.com/morilove37/KoiPage/releases/latest">下载最新版</a> ·
  <a href="#功能">功能介绍</a> ·
  <a href="#界面预览">界面预览</a> ·
  <a href="#快速上手">快速上手</a> ·
  <a href="https://github.com/morilove37/KoiPage/issues">反馈问题</a>
</div>

---

**恋页**是一款面向 Windows 的本地 Galgame／视觉小说管理器。扫描游戏目录、匹配作品资料，用封面和标签整理收藏；打开首页继续上次的游戏，记录每一次游玩，也可以随机挑选下一部作品。转区启动、窗口缩放、游戏翻译和压缩包解压，都可以在实用工具中找到。

![恋页首页：封面切换、游戏信息与最近游玩记录](docs/screenshots/home.png)

## 下载与安装

前往 **[Releases 下载最新版](https://github.com/morilove37/KoiPage/releases/latest)**，选择以 **`_x64-setup.exe`** 结尾的安装包；需要 MSI 格式时选择 **`_x64_zh-CN.msi`**。

- 需要 Windows x64 和 Microsoft WebView2，普通用户无需安装开发工具。
- 安装包包含转区、缩放、翻译与解压工具，首次使用时会释放相关文件，占用额外磁盘空间。
- 已安装的用户可在 **设置 → 关于** 检查更新，确认后下载安装。
- `Source code` 是源码，`latest.json` 和 `.sig` 供更新系统使用，无需手动下载。

完整更新记录见 [更新日志](CHANGELOG.md) 和 [历史版本](https://github.com/morilove37/KoiPage/releases)。

## 功能

| 想做什么 | 恋页提供的功能 |
|---|---|
| **导入作品** | 选择 `.exe`、`.bat`、`.cmd` 或扫描目录，逐款确认或一键批量导入。接入 NextMoe、VNDB、Bangumi、2DFan，可选择默认资料源；未设置时使用 VNDB。找不到匹配时也可手动填写。 |
| **整理收藏** | 封面网格与列表视图，支持搜索、标签与状态筛选、收藏和排序；在详情中设置自定义封面，按作品开启封面打码。封面保存在管理器内，删除游戏本体后仍可显示。 |
| **记录游玩** | 启动后显示运行状态，自动记录时长；汉化启动器或脚本提前退出后继续跟踪后续游戏进程。日／周／月图表可切换历史周期，配合日历回顾玩过的作品。 |
| **转区与缩放** | 内置 Locale Emulator 和 Magpie，可设置转区启动、随游戏启动缩放工具，并选择缩放模式。LE 支持 32 位游戏；Magpie 启动后按其快捷键放大窗口。 |
| **翻译与解压** | 内置 LunaTranslator，支持独立启动或随游戏启动；ZIP、RAR、7z 与分卷可直接解压并扫描导入，成功后原压缩包移入回收站。 |
| **关注角色生日** | 首页展示今天及未来 30 天内的主要角色生日，支持资料修正、隐藏和备份。 |
| **分享游玩足迹** | 生成包含原名、评分与时长的分享图，支持隐藏作品、替换封面、保存图片及生成 24 小时分享链接。 |
| **布置与备份** | 浅色、深色、跟随系统和液态玻璃主题，支持预设与自定义主题色。提供离线标签汉化、数据导入导出、数据库备份、日志导出和托盘操作。 |
| **恢复与搬盘** | 完整备份数据库与本地图片，校验预览后恢复；检查离线或缺失路径，搬盘后批量修复，保留游戏记录。 |
| **单款配置与批量整理** | 每款独立选择转区、Magpie、Luna 或跟随全局；批量编辑状态、收藏和标签，保存常用筛选与视图偏好。 |

## 快速上手

1. 在游戏库点击 **添加游戏**，选择启动文件或扫描游戏目录。
2. 确认名称与启动程序，核对匹配资料后导入；多部作品可一键批量处理。
3. 在详情页设置启动方式、封面和游玩状态，点击启动后自动记录时长。
4. 在首页查看最近记录、历史图表与日历；按需在设置中调整主题并备份游戏库。

默认资料源可在 **设置 → 资料匹配** 更改；一键导入优先采用默认源的可信匹配，没有合适结果时尝试其他来源。

## 界面预览

截图使用维护者实际导入的游戏收藏，作品并非应用预置内容。首页和游戏库展示 v0.6.1 的实际界面，其余截图拍摄于 v0.5.0，部分界面已随更新调整；游戏封面与资料归各自权利人所有。

### 游戏库

![游戏库：封面网格、搜索、状态和标签筛选](docs/screenshots/library.png)

### 实用工具

<img src="docs/screenshots/tools.png" width="900" alt="实用工具：转区启动、窗口缩放、缩放模式与效果链" />

<details>
<summary><strong>更多截图：作品详情、启动设置、时长、日历、分享与主题</strong></summary>

### 作品详情

![作品详情：评分、发售日、原名与简介](docs/screenshots/detail.png)

### 路径与启动设置

![路径设置：安装目录、启动程序、工作目录和存档路径](docs/screenshots/detail-files.png)

### 游玩概览

![游玩时长图表与游戏库状态分布](docs/screenshots/playtime.png)

### 日历回顾

![日历回顾：按日期查看游玩时长与作品](docs/screenshots/calendar.png)

### 分享足迹

![分享编辑器：排序、隐藏作品、替换封面和图片预览](docs/screenshots/share.png)

### 液态玻璃主题

![液态玻璃主题：渐变背景与半透明收藏卡片](docs/screenshots/glass.png)

自定义壁纸在液态玻璃主题下展示，可调整透明度、模糊与填充方式。

</details>

## 数据与网络

游戏库、设置和游玩记录保存在本机，数据库位于 `%APPDATA%\com.galgame.manager\galgame.db`；原封面和自定义封面保存在同一数据目录的 `covers` 中。支持 JSON／CSV 游戏条目导入导出、数据库快照和 `.koibak` 完整备份。完整备份包含数据库和引用的本地图片，不包含游戏本体与游戏存档；恢复前预览校验并保存当前数据，完全退出重开后生效。详见 [备份恢复说明](docs/backup-format.md)。覆盖安装沿用原有数据，删除游戏库记录不会删除磁盘上的游戏文件。

游玩期间每 30 秒保存确认时长。异常退出后恢复到最后检查点，管理器关闭期间不会继续计时；详情中的游玩历史支持补记、修正与删除。游戏运行时退出管理器会结算至退出时刻，游戏本体继续运行。

资料匹配会将搜索词发送给所选数据源，远程图片下载、在线翻译和版本检查需要网络。标签汉化使用内置离线词典，游戏简介保留原文。分享图可直接保存或复制；只有主动生成分享链接时，才会上传到第三方服务。

## 使用文档与开发

[转区启动](docs/locale-emulator.md) · [Magpie 窗口缩放](docs/magpie.md) · [Luna 游戏翻译](docs/luna-translator.md) · [压缩包解压](docs/archive-import.md) · [标签汉化](docs/localization.md)

技术栈：**Tauri 2 · Rust · React · TypeScript · Vite · Tailwind CSS · SQLite**。

开发环境需要 Windows x64、Node.js 24、项目声明版本的 pnpm、Rust stable、MSVC 构建工具、Windows SDK 和 WebView2。

```bash
git clone https://github.com/morilove37/KoiPage.git
cd KoiPage
corepack enable
pnpm install --frozen-lockfile
pnpm tauri dev
```

开发、验证与发布步骤见 [开发说明](docs/development.md) 和 [版本发布流程](docs/publishing.md)。

## 资料来源与许可

作品资料来自 [鲲 Galgame 论坛／NextMoe](https://www.kungal.com/)、[VNDB](https://vndb.org/)、[Bangumi](https://bgm.tv/) 和 [2DFan](https://2dfan.com/)。资料与封面归各自权利人所有，使用时应遵守数据提供方的条款。恋页用于管理本机已有游戏，不提供游戏下载。

应用图标为《天津罪／アマツツミ》水无月萤的 Q 版再创作，角色归 Purple software 所有，本项目与原作官方无隶属关系。详见 [图标与角色来源](docs/branding.md)。

内置第三方工具保留原始许可与来源说明：

- [Locale Emulator](https://github.com/xupefei/Locale-Emulator)：相关组件按 LGPL-3.0 分发，见 [集成说明](docs/locale-emulator.md)。
- [Magpie](https://github.com/Blinue/Magpie)：按 GPL-3.0 分发，通过独立进程调用，见 [集成与许可说明](docs/magpie.md)。
- [LunaTranslator](https://github.com/HIllya51/LunaTranslator)：按 GPL-3.0 分发，附带第三方许可和对应版本源码，见 [集成与许可说明](docs/luna-translator.md)。
- [7-Zip](https://www.7-zip.org/)：解压组件按 LGPL 及 unRAR restriction 分发，见 [解压工具说明](docs/archive-import.md)。

恋页项目代码采用 **[GNU General Public License v3.0（GPL-3.0-only）](LICENSE)**。第三方依赖、内置工具、游戏资料、角色形象和图片仍遵循各自的许可与权利声明，不因本项目协议而改变。

## 反馈与作者

遇到问题时，请在 [Issues](https://github.com/morilove37/KoiPage/issues) 提供应用版本、复现步骤和截图。也可从 **设置 → 日志** 导出诊断日志用于反馈。

作者：[@morilove37](https://github.com/morilove37)。

抖音：**女友为了我变成4i** · 抖音号 **shuiwuyueying.** · [打开作者抖音主页](https://www.douyin.com/user/MS4wLjABAAAAcKXZbXNLc87TzVG6SzTXl4hUtoA0QbGgt57arDh-HxvVRSovn5fPvJvcD2mbrX8f?from_tab_name=main)。
