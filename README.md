# 模型节点优选 / Model Node Optimizer

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 当前默认模型实测 API 节点速度，推荐稳定的 IP，并按需应用。包名：`dsh-best-ip`。

Benchmark the current DSH default model's API IPs. Testing recommends an address; applying it is a separate, explicit action. No provider credentials or personal routes are bundled.

## 界面预览

![模型节点优选设置界面](<1.png>)

## 安装

需要带有插件管理器、默认模型、Settings、凭据和 Web 服务的 DSH。当前兼容声明为 `>=0.2.1-rc.1`，包含 rc.1、rc.2、rc.3 及后续版本，不设版本上限；这只是安装版本范围，不代表所有后续版本都已实测兼容。Node.js 要求 `>=22`，无需单独安装运行时依赖。仅支持使用 API Key 的默认供应商，暂不支持 OAuth 或其他模型适配器。

### 从 GitHub 安装

仓库推送完成且允许其他人读取后：

1. 在 DSH 侧栏打开 **插件 → 添加插件 / 安装第三方插件**。
2. 在安装来源中填写：

   ```text
   https://github.com/otsffs/dsh-best-ip.git
   ```

3. 查看并确认信任该插件，点击 **安装**，随后选择 **立即启用**。
4. 打开 **设置 → 模型节点优选**。

正式分发建议固定实际存在的 Git tag 或 commit。Git 仓库不可匿名读取时，其他用户不能直接按上述地址安装。插件有宿主进程权限，请仅安装你信任的版本。

### 从发布包安装

维护者运行 `npm pack` 生成 `.tgz` 后，可以将它作为 GitHub Release 附件分发。在同一个安装输入框中填写该包在 **DSH Host 上的绝对路径**；这不是浏览器文件上传。远程 Web 用户应使用服务器能读取的路径。

发布到 npm 后，也可在安装输入框中填写 `dsh-best-ip@版本号`。GitHub/tgz 安装不要求先发布 npm；仅创建仓库或发布 npm 不会自动进入 DSH 的 Discover 列表，Discover 需要配置第三方插件索引。

## 使用

- **自动测速**：发现有效 IP、测速并保存推荐，不改变当前 IP。
- **自动测速并应用**：成功后应用本轮推荐；失败或停止时保留原 IP。
- **最大测速 IP 数**：`10 / 任意（自定义） / 全部`，默认全部。按 ping 从低到高选取，失败的 IP 也占用名额，不用更慢地址补位。当前选择立即用于两个按钮，点击保存可长期保留。
- **测一下当前地址**：仅测试当前生效地址；未应用 IP 时使用系统 DNS 的 IPv4 地址，不改变选择。
- **停止测试**：取消在途和排队请求，保留已完成样本，不应用部分结果。已发出的请求可能已经计费。
- **应用此地址 / 清除并恢复系统 DNS**：显式应用或清除选择。

页面默认显示 **全部最多约12w token**，旁边的 **!** 图标悬停可查看详细预算：160 个有效 IP × 3 次 × 最多 256 输出 token = 122,880 输出 token，另计输入 token。160 是额外扫描预算，DNS 返回地址可能额外增加；实际费用取决于有效 IP、输出长度及供应商计费。

插件始终跟随目标用户的 DSH 默认供应商/模型，不携带预设供应商 ID、API 地址、凭据或已选 IP。切换默认模型不会自动测速。

## 配置和限制

安装层见 [cordis.patch.yml](<cordis.patch.yml>)，其余默认值由插件提供：

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `maxBenchmarkIps` | `0` | 0 为全部，正整数为付费测速 IP 上限 |
| `maxCandidates` | `160` | 额外 Cloudflare 地址探测上限，不含 DNS 返回地址 |
| `benchmarkRuns` | `3` | 每个入选 IP 的相同复测次数，范围 1–5 |
| `scanEdges` | `true` | 在 DNS 地址之外采样 Cloudflare 边缘网段 |
| `dnsServers` | 公共 DNS 列表 | 只用于手动发现候选；空列表仅用系统解析器 |

- 支持 HTTPS OpenAI Chat Completions、OpenAI Responses、Anthropic Messages；不猜测其他协议或特殊认证。
- 仅扫描/测速 IPv4。探测验证目标域名的 TLS 证书；测速使用原域名的 Host/SNI，连接候选 IP。
- TCP 延迟（界面的 ping）只用于选择测试顺序，不决定最终推荐。
- 流式速度为输出 token 数 ÷ 首 token 到响应结束的时长。无有效 usage、截断、错误或过短样本不能获得可靠推荐。
- 稳健得分使用 Q25、相对波动和可靠样本率：`Q25 / (1 + IQR / median) × 可靠样本率²`。至少需要 2 次可靠样本和计划次数的严格多数；原始 TPS 保留显示。
- 网络路径、代理、模型负载和限流都会影响结果。推荐只针对本次测试候选和工作负载，不保证全局最快。
- 只有显式应用的地址才影响新建 DNS 连接；不修改操作系统 DNS，也不代表已存在的连接池会立即切换。同域名的不同供应商无法通过全局 DNS 钩子独立选择冲突 IP。
- 设置接口仅接受本机回环客户端的同源 POST。远程 Web 管理目前不在支持范围内。

## 隐私

- 没有遥测或作者配置的采集端点。只有用户显式发起测试时才进行候选发现和付费请求。
- 公共 DNS 会收到要解析的供应商域名；候选 IP 会收到目标域名的 TLS SNI。测试请求会携带该供应商的 API Key，因此只应测试你信任、证书验证通过的服务。
- API Key 由本机 DSH 凭据服务在显式操作时读取。新测速结果不保存密钥、测试提示词、完整端点 URL 或原始错误响应；工作负载元数据只保留 provider/model、端点 origin 和数值预算。旧记录的 benchmark context 在读取时也会去敏。
- 测量结果在当前 profile 的 `dsh-best-ip/state.json` 中；未使用 profile 时保存到 DSH home。记录仍含域名、IP、模型及测量信息，请勿公开上传运行记录或凭据。
- [.gitignore](<.gitignore>) 排除环境文件、凭据、运行状态、日志和生成包；[package.json](<package.json>) 的发布白名单只包含运行时文件、界面资源、安装层、说明和许可。测试和开发脚本不随安装包分发。

## 开发与检查

从源码目录执行，无需 `npm install`：

```sh
npm run check
npm test
npm run check:package
npm pack
```

- 测试通过注入 DNS、HTTPS、凭据和存储替身运行；预载器阻止真实网络，并避免加载本机 DSH profile 的 schema 模块。存储测试只使用自有临时目录。
- `check:package` 离线执行 `npm pack --dry-run --ignore-scripts`，核对完整的发布文件白名单和通用隐私规则；它不安装、不上传、不发布。
- `prepack` 会执行语法、测试和包检查。没有安装时脚本或构建步骤，Git/tgz 安装直接使用成品 JavaScript。
- GitHub CI 在 Linux/Windows、Node 22/24 上配置了相同检查；本地静态/离线通过不等于已实际验证所有 DSH 版本或安装渠道。

## 参考与许可

- [DSH bundle 发布规范](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
- [DSH 插件管理界面](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.md)
- [Cloudflare IPv4 清单](https://www.cloudflare.com/ips-v4)：内置静态采样清单，不在运行时下载。

采用 [MIT License](<LICENSE>)。
