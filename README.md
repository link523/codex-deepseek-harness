# Codex ↔ DeepSeek Harness Desktop

通过 **Codex 插件 + DeepSeek 桌面扩展**，让 Codex 在真正的 DeepSeek Harness App 会话中下发任务、发送后续消息、等待结果、取消当前任务并同步对话。适配 Windows 和 macOS，不使用截图、鼠标键盘控制、辅助功能接口或浏览器调试端口。

当前版本：`0.2.0`。无第三方运行依赖，需要 Node.js **22.19+ 或 24+**、支持本地插件的 Codex，以及已完成初始化的官方 DeepSeek Harness 桌面 App。实现依据为本机桌面版 **0.2.1-rc.5** 的会话服务；扩展会检查必要接口，0.3 等后续版本需要重新确认兼容性。

## 安装

把整个项目放在用户目录内。首次使用 DeepSeek Harness 时，先正常打开并完成设置。安装扩展前，**从托盘或应用菜单完全退出 DeepSeek Harness**；关闭窗口可能只是隐藏窗口。

Windows PowerShell：

```powershell
cd "$env:USERPROFILE\codex-deepseek-harness"
node scripts/install.mjs --all --dry-run
node scripts/install.mjs --all
```

macOS 终端：

```sh
cd ~/codex-deepseek-harness
node scripts/install.mjs --all --dry-run
node scripts/install.mjs --all
```

安装器使用 App 自带的包管理命令离线安装本地 `dsh-codex-bridge` 扩展，并为 Codex 的个人插件来源添加条目。已有个人插件条目会保留，修改前生成备份；不修改 DeepSeek 的模型、登录凭据、权限预设和 App 安装包。

然后：

1. 首次调用插件工具时，会自动打开 DeepSeek Harness 并等待桥接就绪；也可以自行打开 App。
2. 重新启动 Codex，在插件目录的个人本地来源中安装 **DeepSeek Harness**。
3. 在 Codex 提供的钩子信任审查中检查并信任 `UserPromptSubmit` 同步钩子。宿主未信任时，工具仍可手动同步，但下一条消息前的自动补齐不会运行。插件不会自行更改信任设置。
4. 执行 `node scripts/install.mjs --doctor`，应看到 `companionInstalled: true` 和桥接能力信息。

只安装一侧可用 `--deepseek` 或 `--codex`。App 在非默认位置时设置 `DSH_DESKTOP_PATH`：Windows 指向 `.exe`，macOS 指向 `.app`。用户目录通过系统接口获取，不硬编码用户名。

如果 `--offline` 提示本机缺少既有插件依赖，请检查 DeepSeek 自身的插件环境；本扩展没有需要联网下载的依赖。不要为了安装本扩展而清空现有插件或锁文件。

## 使用

在启用插件的 Codex 对话中说：

> 让 DeepSeek Harness 在 C:\\Projects\\demo 中检查测试失败原因，执行修复，并把最终结果同步回来。

或者：

> 关联 DeepSeek 已有的某个对话，把它的新消息同步到这里。

Codex 可以选择已有会话，或在指定项目里创建新会话。新建会话会加入 DeepSeek 工作区，因此能在 App 侧边栏看到。任务沿用 App 已配置的模型和工具权限；需要批准或回答时，等待返回 `input-required`，由你在 DeepSeek 中处理。

主要工具：

| 工具 | 功能 |
| --- | --- |
| `dsh_status` | 检查连接、能力和同步限制 |
| `dsh_workspaces` / `dsh_list_sessions` | 选择项目和 App 会话 |
| `dsh_create_session` | 创建可在 App 中看到的会话 |
| `dsh_send` | 下发任务、追问、补充或转向；同一消息重试复用 `requestId` |
| `dsh_sync` | 按事件游标读取新增消息，支持分页 |
| `dsh_wait` | 本地等待完成、消息或需要输入 |
| `dsh_cancel` | 取消当前任务；DeepSeek 会保留其排队消息 |
| `dsh_bind` / `dsh_unbind` | 双向关联/解除：Codex 提示前拉取 DeepSeek 新消息，App 打开会话时镜像 Codex 记录 |

## 自动打开桌面软件

调用任意需要 DSH 的工具时，插件会先检查连接。如果软件尚未运行，会自动打开已安装的 App，最多等待 30 秒，然后继续原操作；无需先手动打开 DSH。多个工具同时调用时，共享同一次启动过程。软件已经运行时直接使用已有连接。

macOS 使用系统 `open` 打开 `.app`，Windows 直接启动 `.exe`，均不经过 shell，也不使用屏幕或键盘鼠标控制。非默认安装位置继续使用 `DSH_DESKTOP_PATH`。

自动启动只检查桥接就绪，不调用模型。发送或创建操作只在就绪后执行一次；传输失败后的不确定操作不会自动重放。首次初始化未完成或配套扩展未启用时，启动等待会超时并返回具体提示。

后台 `UserPromptSubmit` 增量同步及 `--doctor` 诊断不会打开软件。取消等待不会关闭已经打开的 App，也不会取消其他并发调用的启动等待。

本版本的自动启动在 Codex 插件侧实现。双向记录同步需要 `dsh-codex-bridge 0.2.0` 配套扩展；从 0.1.x 升级后请重新执行安装器（`node scripts/install.mjs --deepseek` 或 `--all`），完全退出并重新打开 DeepSeek Harness。

## 同步与 token

**等待期间**：默认 `until: "settled"`。等待过程只检查状态，不反复复制和序列化整段历史；初始时检查会话与游标，返回时才生成同步结果。增量同步用二分查找定位游标后的事件，避免逐项扫描已读前缀。桥接扩展监听会话事件，并用本地看门狗检查旧版 App 的待审批状态；这段程序不调用任何大模型。只有工具返回结果后，Codex 处理内容才有模型开销。默认不回传逐 token 输出、私有推理和工具大日志；只回传新增对话和生命周期事件，且限制单次长度。需要工具细节时可以显式设置 `includeTools: true`。

DeepSeek 执行任务本身照常消耗所选模型的 token；这里减少的是 Codex 反复查看进度的开销。没有新增消息时，同步钩子不向模型插入空状态。连接错误会区分取消、超时、桥接不可达和响应异常；发送结果不确定时，只能使用原 `requestId` 重试。

**双向记录同步（Codex → DeepSeek）**：`dsh_bind` 现在同时记录 Codex 会话 ID。配套扩展在 App 打开该 DeepSeek 会话时，每 3 秒查看对应的 Codex 会话转录（默认 `~/.codex/sessions`，可用 `CODEX_HOME` 指定），把其中真实的用户提问和助手回复追加到 DeepSeek 会话。新增记录按 Codex 消息 ID 去重，重启 App 后从上次读取位置继续；`fromStart: true` 会同时补齐绑定前的历史，默认只同步绑定之后的新记录。Codex 侧的 developer 提示、环境注入、钩子上下文、推理和工具调用不会进入 DeepSeek 对话；镜像消息带有来源标记，不会再被 `dsh_sync` / `dsh_wait` 传回 Codex。用户提问显示为普通用户气泡；App 的聊天界面只渲染有对应步骤开始事件的助手消息，因此每条镜像回复都带自己的步骤边界，步骤序号从 10000 起，永远不会和 DeepSeek 真实步骤（1、2、…）落在同一个聊天上下文里。记录追加到会话当前最后一轮；会话还没有任何一轮时，扩展会新建一轮承载导入内容。DeepSeek 会话未在 App 中打开时没有可追加的运行时日志，扩展会跳过该关联，等会话打开后继续。旧版本写入的关联文件没有 Codex 会话 ID，升级后需要重新 `dsh_bind` 一次。

**你在 DeepSeek 直接聊天时**：消息同样属于会话事件。只要关联了该会话，下一次在 Codex 发消息时，已信任的钩子会把增量消息加入 Codex 上下文。不同 Codex 对话分别保存关联与游标，不会默认混在一起。游标提交使用跨进程锁与关联版本校验：较晚结束的旧同步不会把游标倒退，也不会恢复已经解除或覆盖已经更换的关联。这是上下文同步，不会把 DeepSeek 消息伪装成 Codex 原生的用户/助手消息气泡。

**Codex 空闲时主动唤醒**：当前本地 stdio 插件没有已验证的宿主推送入口，因此本版本明确返回 `idlePush: false`。空闲期间 DeepSeek 的消息保存在 App 自身的会话日志中，下次同步会补齐。本版本没有通过写 Codex 数据库、修改会话转录、模拟用户输入或隐藏模型调用来伪造实时推送。

官方 MCP Events 文档目前列出的场景是 ChatGPT 云端 Work 等环境，需要 HTTP 服务和 webhook；不能据此声称本地 Codex 插件能够直接唤醒原对话。若以后 Codex 提供本地推送能力，可在现有增量同步上增加投递层。

**超时仍有少量成本**：Codex 文档中的默认单次 MCP 工具超时为 60 秒，所以插件默认等待最多 50 秒。如果任务更长，Codex 重新发起等待仍产生工具调用和模型处理开销；不能保证端到端零 token。

需要减少长任务的重复等待时，可以使用同一 MCP 服务的直接配置方式，并提高宿主超时。此时不要同时启用插件提供的同名 MCP 服务：

```toml
[mcp_servers.deepseek_harness]
command = "node"
# 换成当前机器的真实绝对路径；Windows TOML 可使用正斜杠。
args = ["/Users/your-name/codex-deepseek-harness/plugins/deepseek-harness/server/index.mjs"]
tool_timeout_sec = 660
```

然后显式调用 `dsh_wait` 并传入 `timeoutMs: 600000`，最多等待十分钟才超时返回。等待期间的本地事件处理不会产生模型 token。插件来源的超时覆写是否可用依具体宿主版本而定，本项目没有写入未经文档确认的配置字段。

分页返回 `hasMore: true` 时，继续使用返回的 `cursor` 拉取，直到补齐。特别长的单条消息会标记 `truncated` 并返回预览；需要更多内容时以同一个 `afterSeq` 重读并提高 `maxChars`（最高 100000）。

## 连接与数据

- 扩展只监听 `127.0.0.1` 的系统分配端口，拒绝浏览器 Origin/Fetch 请求和错误 Host。
- 每次启动产生新的随机凭据，写入 `$DSH_HOME/codex-bridge/connection.json`；默认 DSH_HOME 为 `~/.dsh`。macOS 使用目录 0700/文件 0600；Windows 沿用当前用户目录的访问控制。
- MCP 客户端只连接固定的本机地址，不接受重定向，也不会把凭据写进工具输出。
- 不读取或复制 DeepSeek 的账户/API 密钥。桥接凭据和关联文件不要分享。
- 关联游标位于 `codex-bridge/links/`。`DSH_CODEX_DATA_DIR` 可单独修改关联文件位置，不影响桥接发现位置；`DSH_CODEX_CONNECTION_FILE` 可显式指定连接文件。
- 同步到 Codex 的消息会进入 Codex 模型上下文；这并不是“数据永远不离开本机”的模式。

## 验证与卸载

```sh
node --test tests/*.test.mjs
node scripts/install.mjs --all --dry-run
node scripts/install.mjs --doctor
```

48 项测试覆盖长历史增量定位、等待快照次数、跨进程游标单调提交、关联切换与解除、连接目录隔离、响应体超时，以及本机 HTTP 鉴权、跨站拒绝、任务提交与重试、按序增量同步、分页、等待完成/超时/审批/取消、钩子与会话隔离、Codex 转录过滤与增量镜像、MCP JSONL 交互及两平台路径。测试使用隔离的模拟会话，不发送付费模型请求，也不会修改你的真实 DeepSeek 对话。GitHub Actions 已配置 Windows/macOS 与 Node 22/24 矩阵；本地 Windows 测试通过不代表 macOS 真机已验证。

卸载时在 Codex 中移除插件；完全退出 DeepSeek Harness 后，用 App 提供的 `dsh plugin --profile desktop remove dsh-codex-bridge` 移除配套扩展。安装器没有替换你已有的 `dsh` 命令。

参考：[OpenAI 插件打包](https://developers.openai.com/plugins/build/plugins)、[桌面本地插件](https://developers.openai.com/plugins/deploy/desktop-only)、[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[MCP 工具超时](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[MCP Events 范围](https://developers.openai.com/plugins/build/mcp-events)、[DeepSeek 官方桌面 App](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)、[会话控制服务](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/README.md)。
