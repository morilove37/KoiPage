# 版本发布与应用内更新

公开仓库：<https://github.com/morilove37/KoiPage>。

## 用户更新流程

发布版默认启动三秒后检查 GitHub 最新正式版本，也可在「设置 → 关于」手动检查。检查只获取版本信息，不下载安装包。

发现新版后显示版本与说明。用户选择「下载并安装」后才下载；原生更新插件验证签名，安装前再次检查游戏是否已退出，再启动 Windows 安装程序并重新打开应用。网络或签名错误会停止更新，原有应用可以继续使用。

没有更新功能的旧版本需要手动安装一次带更新功能的版本。修改 GitHub 源码不会直接改变用户已经安装的应用。

## 发布新版本

1. 同步修改 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 的版本号。
2. 更新 `CHANGELOG.md`，新增 `docs/releases/v版本号.md`，写明变化和使用说明。
3. 执行验证命令并推送 `main`。
4. 创建并推送对应标签，例如：

   ```bash
   git tag v0.3.0
   git push origin v0.3.0
   ```

5. `Release` 工作流构建 Windows x64 安装包、更新签名及 `latest.json`，上传到对应的 **Release 草稿**。
6. 检查下载文件与更新说明后，发布该草稿。发布后的最新正式版本才会被应用检测到。

工作流也可手动触发，版本以当前配置为准。主分支的 `Check` 工作流执行前端构建、接口契约检查、发布配置检查和 Rust 离线测试。

## 更新签名

应用配置只包含公钥。私钥与密码保存在 GitHub 仓库的 Actions Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

不要将它们写入源码或日志。首发签名文件另保存在维护者本机 `%LOCALAPPDATA%\KoiPage\signing`，密码文件使用 Windows 当前用户保护。应将签名材料另行安全备份；换电脑时不能只复制 Windows 保护的密码文件。

本地构建时由维护者将私钥路径和密码放入相应环境变量后执行 `pnpm tauri build`。开发者自行编译分发时应使用自己的密钥与更新地址。

更新签名用于验证更新来源，不等同于 Windows Authenticode 发行者证书。

## 固定配置

- 数据标识：`com.galgame.manager`。
- MSI UpgradeCode：`6DEDB5F6-B6AD-591D-9E2F-6A962908D12D`。
- 更新地址：`https://github.com/morilove37/KoiPage/releases/latest/download/latest.json`。
- Windows 安装方式：`passive`，显示安装进度。
- EXE 与 MSI 均保留，更新清单优先采用 NSIS 安装包。

原生实现与清单格式参见 [Tauri 更新插件文档](https://v2.tauri.app/plugin/updater/)，工作流参考 [Tauri GitHub 发布文档](https://v2.tauri.app/distribute/pipelines/github/)。
