# 版本发布与应用内更新

本仓库公开桌面客户端源码。生产服务、运维工具、内部部署记录、凭据和恢复材料不进入公开仓库，也不作为 Release 附件分发。

## 发布检查

1. 在公开客户端工作副本中同步 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 版本号，并更新公告与变更记录。
2. 执行 `pnpm check:public`、`pnpm build`、`pnpm check:ipc`、`pnpm test`、`pnpm check:release` 和 `cargo test --lib --locked`。
3. 只推送经过检查的客户端源码。不要从同时包含生产维护文件的开发目录直接推送，不要上传完整开发目录的压缩包。
4. 按版本创建标签，由 Release 工作流生成安装包、更新签名和清单并保存为草稿；核对产物后再发布。

公开源码中保留客户端必须使用的法律政策 JSON。它包含公开告知版本与服务地址，不包含服务端密钥。

## 更新与签名

发布版可自动检查新版，用户确认后才下载和安装；原生更新插件验证签名，安装前确认游戏已经退出。网络或签名验证失败会停止更新。

应用配置只包含更新公钥。签名私钥和密码由维护者独立安全保管，通过 Actions Secrets 或构建环境注入，不写入源码、日志或发布附件。开发者自行分发时应使用自己的签名密钥和更新地址。

客户端数据标识、MSI 升级标识和官方更新地址由 `pnpm check:release` 核对。更新签名与 Windows Authenticode 发行者证书是不同机制。

参见 [Tauri 更新插件](https://v2.tauri.app/plugin/updater/) 与 [GitHub 发布流程](https://v2.tauri.app/distribute/pipelines/github/)。
