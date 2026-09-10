# GPG 发布校验

项目发布公钥位于 `config/release-public.asc`，完整指纹为：

`921C86924526C92ADB8924835151AEB0350CE3ED`

此公钥由维护者个人密钥 `DB9FB9FFA06B1771D732350A5FCE38AE11E1F096` 认证。公钥可以公开；项目私钥和密码仅通过 Actions Secrets `RELEASE_GPG_PRIVATE_KEY`、`RELEASE_GPG_PASSPHRASE` 提供给签名步骤。CI 不需要个人私钥。

主分支同一提交的 CI 全部成功后，推送 `v1.0.0-rc.N` tag 触发发布。发布不重新打包：下载和验证该提交的 CI 产物，签署 SHA256SUMS.txt，并用仓库公钥验证签名。安装包、清单、分离签名、公钥和证据 ZIP 全部上传后自动公开为 prerelease，不设为 latest。没有 Secrets、密码错误、指纹不匹配、签名失败都会阻止发布。

在下载目录中验证（使用可信渠道核对完整指纹）：

```bash
gpg --show-keys --with-fingerprint release-public.asc
gpg --import release-public.asc
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum --ignore-missing -c SHA256SUMS.txt
```

只有签名验证成功，且所下载安装包显示 OK，才完成校验。清单签署安装包哈希；证据 ZIP 是附加构建证据，不在当前签名清单内。

GPG 不消除 Gatekeeper/SmartScreen 提示。包未使用 Apple Developer ID/公证或 Windows Authenticode，发布不要求购买这些服务。

现有 RC tag 不会因修改 workflow 自动重发。请在新提交 CI 通过后创建新 RC tag；若上传中断留下草稿，先检查该草稿，再人工处理后重跑，脚本不会覆盖已有发布。
