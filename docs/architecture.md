# Architecture

本文描述 UnderControl 当前必须保持的系统边界。面向用户的安装、使用与排障入口见 [`README.md`](../README.md)。历史 specs 和 job logs 记录决策过程，不代表现行 runtime contract。

## System shape

```text
CLI-owned sessions ◀──adapter── daemon ──HTTP──▶ Dashboard
                                  │
Agent session_link ──HTTP────────▶│──▶ session-links.sqlite
Action Markdown ──watch───────▶│──▶ scheduler.sqlite
Teams ──HTTP───────────────────▶│──▶ loop_* / execution_resources（同一库）
                                  │
                                  └──▶ Runtime Registry ──▶ local agent CLI
```

macOS `launchd` 与 Linux `systemd --user` 均只管理一个 `daemon` 常驻服务。`daemon` 是唯一 SQLite writer、管理与独立触发端口的唯一 HTTP/SSE 服务、唯一 scheduler 和唯一 Run supervisor。

## Host service lifecycle

`server/control.mjs` 按真实平台选择 macOS LaunchAgent 或 `server/control/systemd.mjs`，Windows 不进入安装路径。Linux controller 写入用户级 `undercontrol.service`，确认 Node.js 24、用户 manager、端口占用与预构建资产；启用后只重启一次服务。ExecStart 固定为可信 Node 与 daemon 绝对路径，禁用 shell/环境展开，转义 systemd 百分号 specifier 与路径引号。unit 固定 HOME、与 Node executable 一致的 PATH，以及显式 CODEX_HOME，不持久化 API key。日志和 unit 使用用户私有权限。卸载停止并禁用本 unit，删除 unit 后 reload manager；数据和日志保留，不调用 sudo、不改系统 unit 或 lingering。

installer 按 Darwin/Linux 选择不同命名的自包含 archive，校验平台对应的 SHA256 后再切换 current；runtime 本身为同一份跨平台 JavaScript，Node.js 由用户安装。Linux 优先使用 sha256sum，macOS 可使用 shasum。两平台均检查 Node.js 24+、服务配置及预构建入口；健康检查固定走本机地址，展示地址可使用server_public_url。服务卸载失败时不继续删除程序文件。CI 同时运行 macos-latest 和 ubuntu-latest；Release 输出两种 service archive 和原有 adapter archive。

所有archive使用USTAR，显式关闭xattrs与COPYFILE元数据，排除AppleDouble和.DS_Store，生成后检查唯一根目录与元数据条目。installer先对完整列表检查路径越界，再从非元数据条目确定唯一程序根目录；解包继续排除元数据，且根目录必须匹配package.json版本。不得根据压缩包的第一条记录推断根目录。

Release分为macOS构建、Ubuntu安装验证和发布三个job。Ubuntu下载macOS产生的原始archive、installer及SHA256SUMS，在临时HOME中实际安装并直接启动随机端口的daemon，检查版本、Dashboard及SSE，不调用systemd安装。publish依赖Linux验证成功。运行入口server/daemon.mjs读取相邻package.json并注入config.packageVersion，作为/api/v1/meta的service_version；已安装runtime不应返回source。

Linux 按 Web 服务使用，不启动浏览器、桌面终端或 tmux；`undercontrol open` 仅返回配置的公开访问地址，未配置时返回本机地址。默认可通过 SSH loopback 转发访问，也可显式配置原生网络访问。terminalLauncher.supported=false 时 providers 的 resume=false，settings 返回 local_actions_supported=false。Sessions 不显示终端启动按钮，Actions 保留 Session ID 复制并禁用服务器本机文件打开操作，终端选择设置不出现；桌面操作 API 仍返回 typed unsupported。macOS 操作保持原有实现。状态读取通过已有 Codex Unix socket；没有共享服务器时只标记状态不可用，不启动任何 daemon 或使用进程反查。

server_listen_host只接受127.0.0.1或0.0.0.0，省略时沿用server_host，默认仍只监听本机。0.0.0.0不要求server_public_url或客户端白名单；旧server_allowed_clients字段不再参与配置解析或访问检查。serverBaseUrl与UNDERCONTROL_SERVER_URL保持loopback，供CLI/MCP及controller健康检查使用。可选serverPublicUrl只用于CLI展示和打开访问地址。createApiServer直接提供页面、API和SSE，不按客户端IP、Host或Origin拦截；请求URL及文件预览跳转地址根据当前请求的Host生成。开发gateway同样不做Host和Origin拦截，仍仅监听loopback并代理到本机daemon。JSON类型、字段、消息大小及文件路径校验保持有效，Dashboard API不增加CORS响应头。

## Non-negotiable invariants

1. **One daemon**：不得为单个 Action 创建 LaunchAgent、长期 runner 或第二个 control plane。
2. **One execution path**：manual、scheduled 与 external trigger 都调用 `RunService.create()`。
3. **Durable before spawn**：Run 必须先以 `queued` 写入 SQLite，提交后才能解析或启动 runtime。
4. **One Runtime Environment**：daemon 创建一个运行时环境实例，runtime status、model discovery、真实 Run 与 child PATH 都从这里获得 executable context。
5. **File-native definitions**：Action Markdown 是 definition source of truth；SQLite 不复制一份可编辑 definition。
6. **Daemon-owned facts**：只有 `daemon` 写 Run state、session、file changes 与 log references。
7. **No browser commands**：browser 只发送 semantic ID 和 typed fields，不能提交 executable、argv 或 shell text；恢复会话所用 Workspace 必须由 daemon 读取。
8. **Failure isolation**：runtime 缺失、model probe 失败或 Scheduler 故障不能让 Sessions 下线；Session provider 失败也不能中断已配置的 Actions Run。
9. **Bounded operations**：probe、output、logs、events、shutdown 与 cancellation 都必须有明确上限。
10. **Privacy by construction**：Recorder 不持久化 prompt、reasoning、tool payload、streaming assistant delta 或 transcript content；Actions ledger 保留任务快照、本轮 data 和既有 terminal final message；不保存触发鉴权 secret。
11. **Per-Run context policy**：Action 的 Skills/integrations policy 必须进入 immutable Run snapshot，并只通过该 Run 的 runtime argv/protocol 生效；不得修改全局 CLI config 或共享 profile。
12. **Native session ownership**：原生会话、正文、时间与原生关系由 CLI 维护。只持久化外部协作关系，不维护第二份 Task 投影或 transcript。
13. **Retired data preservation**：正常启动不导入 Task store/service，不打开、迁移、checkpoint 或修改历史 tasks.sqlite、spool 和生成文件。

## Runtime registry

Registry 保存 immutable runtime definitions，不动态加载用户代码。每个 definition 只描述 runtime-specific behavior：

```js
{
  id,
  displayName,
  launch,
  versionProbe,
  fallbackModels,
  capabilities,
  fetchModels,
  buildInvocation,
  parseEvent,
  createInteractiveSession,
  readConversation,
}
```

Shared infrastructure 负责 executable candidate ordering、canonicalization、version probe、cache、child PATH repair、process supervision、timeout/cancel、Run persistence 和 SSE。只有已 canonicalize 为 executable file 的候选才消耗 bounded probe budget；不存在的 PATH entry 不得遮蔽后面的健康 CLI。Runtime Environment 动态枚举 process PATH、Homebrew、fnm/nvm/mise 等已安装 toolchain，并同时为 resolver 与 child process 生成一致路径。成功解析可 bounded cache；失败解析立即失效，以允许 CLI 安装或环境恢复后的下一次请求自愈。Adapter 不得导入 HTTP、SQLite、cadence 或 UI 模块。

Run store 允许同 Action 多条持久 queued，唯一索引只约束 running。RunService 按入队顺序串行，同一 Action 不并发启动；外部调用不合并或丢弃输入。行级 Run 在执行期间切换为 Stop，整体停用与 schedule_enabled/external_enabled 独立；停用入口不取消已经接收的 Run。

当前注册 `codex` 和 `opencode`。增加 runtime 的最小范围应是：

1. 新增一个 definition；
2. 新增该 CLI 的 stream parser；
3. 添加 resolver、model、invocation 与 parser tests；
4. 把 definition 加入 composition root；
5. 验证现有 Scheduler、Run store 和 Dashboard 无需 runtime-specific branch。

如果新增 runtime 需要修改 Run lifecycle、再建 daemon、再建数据库或让 browser 构造 command，说明 adapter boundary 设计错误，应先停止扩张。

Registry list 只验证 executable availability，不探测登录态。登录态是易变的 provider execution state；真实 Run 才是权威证据。Model discovery 是独立、bounded、可 fallback 的 capability。

## Actions 定义与调用

Actions 升级 Schedule。新定义写 undercontrol/action；旧 undercontrol/schedule 读取不改写，enabled 映射为定时开关，默认关闭外部调用；编辑后保留 ID、路径和正文写为新格式。schedule 可为 null，enabled/schedule_enabled/external_enabled 独立。secret 安全生成并明文写 external_secret，仅管理详情可读，不进入快照、提示词、运行输入或日志。定义继续通过原有 watcher、原子写入与 etag 维护。

同 daemon 默认在 127.0.0.1:43128 独立监听 POST /actions/:id/trigger，仅接受 {secret,data}。先检查体积、格式与密钥，再持久创建 Run，202 只代表已接收。输入 JSON 独立保存，不覆盖运行配置。外部端口不挂载管理、会话或文件路由；沿用现有访问方式，不新增 Host/Origin 拦截。配置、错误码、API/MCP 与外部工具分工详见 [Actions](actions.md)。

## Run lifecycle

Run 创建事务保存不含 external_secret 的任务快照和独立 input_json。启动前根据前一轮实际结果确定 session_mode、session_mode_reason、resume_session_id 和 inherit_run_number；这样队列中的连续请求可继承刚结束的一轮。默认 new；reuse/auto 匹配同 Action、runtime 和 workspace 的最近原生会话。max_inherit_runs 默认 20，首次新建不计入；统计实际记录了同原生 Session 的继承执行，达到上限后换新会话。

auto 的成功 final_message 末尾标记 `<!-- undercontrol:next-session=new|reuse -->` 决定下一轮；失败或缺失默认 reuse，上限优先。RunService 注入协议但不修改 Markdown 正文。Codex 选择 thread/start 或 thread/resume，OpenCode 选择新建 session 或获取原 session；恢复失败不降级新建。UnderControl 不再提供或注入自动压缩阈值，也不主动读取 Runtime 的压缩配置。旧定义的 `auto_compact_token_limit` 只读识别并忽略，保存时不再写出；排队和历史 Run 的快照不改写，CLI 与交互式执行路径都不再应用旧阈值。Codex 原生配置及模型默认压缩机制保持自身行为。

```text
queued
  ├── running
  │     ├── succeeded
  │     ├── failed
  │     ├── timed_out
  │     ├── canceled
  │     └── interrupted
  ├── failed
  └── canceled
```

- `queued` 表示尚未开始调用 Runtime，可等待同 Action 或目录占用。调用 Runtime 前先持久化 running，防止结果不明时被当成未启动请求重放。
- service restart 继续 v5 未启动队列；遗留 running 收口为 interrupted，不自动重跑。v4 queued 缺少明确启动边界，升级时保守收口为 interrupted。
- cancel 可取消指定排队/运行，shutdown 保留未启动队列并终止本服务的执行，不能无限等待第三方 CLI。
- session ID、final message 与 usage 只能来自 normalized runtime events。file changes 优先消费 runtime evidence，并与 `RunService` 执行前后的 bounded Workspace snapshot 合并；snapshot 只在内存保留 metadata，忽略 `.git` / `node_modules`，超出 100,000 files 时 fail open，不阻塞 Run。
- SQLite 只保存最多 128 条已经 containment 检查的 Workspace-relative change paths，不保存 Workspace snapshot 或文件内容。
- log file path 由 daemon 构造；API 不读取 Run ledger 之外的任意 path。

## Active Live Session

Codex 的 active Run 使用 one-process-per-Run `codex app-server --listen stdio://`。这不是第二个 daemon：Actions的process lifecycle、timeout、cancel、terminal persistence与Run status仍由`RunService`管理。共同执行驱动位于`agent-execution.mjs`；Teams使用独立Run记录，不借用Schedule唯一约束。

```text
Dashboard ──GET Run SSE──────────────▶ daemon Run Event Hub
Dashboard ──POST steer/stop──────────▶ RunService
                                            │
                                            └── private turnId ──▶ Codex app-server
```

- browser authority 只有 Run ID 与 daemon-generated `turn_revision`；Codex `turnId` 不出 driver。
- `turn/steer` 只接受 bounded guidance text；`turn/interrupt` 不接受 browser command。
- assistant delta、activity summary 与 intervention acknowledgement 只存在于 bounded memory SSE replay，不写 SQLite 或普通 logs。
- activity normalization 只公开 command label、file count、MCP server/tool 等安全摘要，不公开 arguments、results 或 reasoning。
- terminal SSE 到达后，Dashboard 必须关闭 Live stream 并重新读取 authoritative Run，避免 row/detail/session/summary 分裂。
- completed Run 不在 Dashboard 内继续 multi-turn；后续操作使用已有 Terminal Resume boundary。
- app-server 单帧上限为 16 MiB（包括历史对话响应），按分片累积，完整帧只合并一次，避免大消息反复复制。超限仍以 `RUNTIME_PROTOCOL_FRAME_TOO_LARGE` 收口，不能无限分配内存。
- protocol request、frame、Run timeout 与 process shutdown 都有上限；`SIGINT` 无效时升级为 `SIGKILL`。

### Context capability isolation

Schedule 可分别把 `skills` 与 `integrations` 设为 `inherit` 或 `disabled`。旧 Markdown 缺省时保持 `inherit / inherit`；Codex 的 Dashboard/API 新建时默认 `disabled / disabled`。`integrations` 只包含 MCP servers、plugin MCP 与 Apps/Connectors，不包含 Web Search 或 Codex core tools；Sandbox 仍独立决定文件系统与网络权限。

Codex adapter 在 spawn 前用同一 executable、cwd 与 child environment 执行 bounded `codex mcp list --json`，再通过本 Run 的 app-server argv 明确禁用 plugins、Apps 和枚举到的 MCP identities。`skills: disabled` 时，adapter 在 `thread/start` 前调用 `skills/list`，为该 Workspace 的每个 Skill path 写入 thread-local disabled config，同时关闭 Skill search 与 Skill MCP dependency install。任何 discovery 失败都在创建 Thread 前 fail closed，返回 typed Run error；不得以“部分禁用”继续执行。

## Terminal conversation read

Completed Run history does not create a UnderControl transcript store:

```text
Dashboard ──GET /runs/:id/conversation──▶ RunService
                                               │ trusted Run facts
                                               ▼
                                     Runtime adapter readConversation
                                               │ thread/items/list
                                               ▼
                                      CLI-owned local session
```

- browser 只能提交 Run ID；`RunService` 从 ledger 取得 runtime ID、session ID 与 immutable Workspace snapshot；
- Codex adapter 启动 bounded app-server client，优先使用 `thread/items/list` 分页读取，旧 CLI 明确不支持该方法时才回退 `thread/read({ threadId, includeTurns: true })`；
- response 只规范化 `userMessage` 与 `agentMessage`，丢弃 reasoning、command、MCP/tool payload 与其他内部 item；
- normalized messages 仅存在于 request/React query memory，不写 SQLite、Run logs、localStorage 或 persistent cache；
- 本机 CLI session 缺失或协议不可用时返回 typed unavailable，UI 可回退到已经存在的 bounded `final_message`；
- 该路径只读历史；completed Run 的继续对话仍通过 Terminal Resume，不从 Dashboard 创建 follow-up Turn。

## Session browser

`server/src/session-browser.mjs` 注册会话 adapter，独立于 Run ledger。当前仅注册 `runtime/adapters/codex-sessions.mjs`，未来 Claude Code 通过自己的 adapter 读取原生数据，无须模拟 Codex JSON-RPC。会话 provider 与 Actions runtime registry 的能力分别维护，关系工具支持某个 agent 不代表其原生 Sessions 数据读取已经实现。

Adapter 提供 `id/name/runtimeId/storeId/capabilities`、可信 `resumeOptions`、`list`、`workspaces`、`readSession`、`messages`、可选 `children/timeline/activity/branches` 和 `close`。跨来源引用由 `provider + store_id + session_id` 组成；store_id 由服务器配置的数据目录生成，客户端不能传入任意数据根。Codex 使用具体 thread.id，不使用 fork 共享的 root sessionId。resumeOptions.codexHome 显式设置恢复命令的 CODEX_HOME，避免终端环境切换到另一个数据源；launcher 只接受绝对路径并 shell-quote。列表统一返回 title、preview、workspace、branch、时间、state、可选 snippet、is_subagent、native_parent、forked_from 和 next_cursor；Codex 的 is_subagent 依据 parentThreadId 或 source.subAgent 标记，native_parent 优先使用 parentThreadId，再读取 source.subAgent.thread_spawn.parent_thread_id；无父级的 review 等 subagent 仍保留来源类型。搜索能力必须显式声明。数据源是真相来源，不将 transcript、搜索命中或目录清单写入 SQLite。

当前Codex adapter经现有executable resolver启动列表和对话共享、空闲45秒关闭的只读app-server。初始化开启experimentalApi，浏览RPC最多20秒、协议帧最多8MiB；原生元数据每页最多100条，来源为cli/vscode/appServer/exec，归档单独查询。

macOS LaunchAgent使用Standard进程类型，避免Background分类对用户触发的搜索施加后台CPU及I/O限流。正文搜索由codex-sessions/file-search.mjs优先处理。复用浏览连接分页调用thread/list(useStateDbOnly:true)，避免每批重复启动app-server；先应用cwd、branch及来源限制；realpath后的JSONL必须位于所选数据根的sessions或archived_sessions内。优先解析Codex安装中的rg，再检查PATH及常见工具安装目录；shell:false、忽略rg用户配置，每批最多100个路径且参数不超过48KiB，最多两批并发。正则只接受Codex用户/助手消息和旧event_msg文本，每文件最多一个命中，只输出短节选，不传输整行图片或工具输出。stdout按NUL文件名与LF记录边界解析，并限制每条输出16KiB。结果按活跃时间和ID排序；首次最多检查16个文件，后续最多两批各100个文件，每次检查后即返回。files前缀cursor绑定查询及筛选，按最后已检查会话继续，结果超过limit时按最后返回命中继续，空批次也能前进；scanned_count为本批检查的候选会话数；正文和节选只在本次请求内存中，不建搜索库。缺少rg或元数据不指向普通JSONL时使用原生thread/search；该路径首批limit=1，后续正常批次，过滤空页最多继续3页并返回body前缀cursor。两条路径每批均最多60秒；取消文件搜索会停止本次rg，并在当前元数据RPC结束后停止继续翻页；取消原生搜索会关闭其专用app-server，不会主动关闭共享浏览连接；错误使用SESSION_BROWSER_SEARCH_FAILED。

列表及原生children使用useStateDbOnly=true，避免前台重复扫描rollout修复索引。`adapters/codex-sessions/metadata.mjs`按adapter实例隔离数据源，对规范化参数合并并发请求，最多缓存64页元数据；3秒内直接复用，3–30秒先返回缓存再刷新，过期等待新结果。正文、搜索及命中片段不进入该缓存。UI根列表与目录使用相同100条原生页，不截断数据或重写native cursor。正常核验在首次读取3秒后由独立app-server执行，单数据源合并，最多每5分钟扫描一次非归档与归档页，完成后失效缓存；失败不关闭交互连接。初始根列表为空时必须等待核验，失败不能当作空列表。后台连接完成即关闭，adapter.close释放连接、watcher和timer。

原生通知、sessions/archived_sessions下的jsonl变更及session_index.jsonl触发失效，1秒合并发布SSE。root watcher只监听上述入口，不递归插件或其他配置；日志watch失败时由页面可见期间15秒元数据补查与按需后台核验兜底。目录、分支目录、无搜索的列表、children和relations接受修订；正文搜索不被事件轮询。旧代请求不能覆盖新代缓存。

命中预览使用 `thread/searchOccurrences` 返回的 turnCursor，再调用 `thread/turns/list`；只展示 userMessage 文本和 agentMessage，忽略工具与 reasoning。每次最多 5 个 turn、256 KiB 字符，单消息最多 16 KiB 字符，截断时显式告知；命中消息预留空间。旧版本缺少搜索/分页方法时返回 typed unsupported，不使用 preview 替代正文搜索。当前只定位首处命中，允许切回最近对话与加载更早页。

HTTP 入口为 `/api/v1/session-browser/providers`、`/:provider/workspaces`、`/:provider/sessions`、`/:provider/activity`、`/:provider/sessions/:id/read|children|timeline|messages|resume` 以及 `/relations`、`/links`、`/pins`、`/:provider/pinned`（均在 session-browser 前缀下）。读取支持有界 query/workspace/archived/cursor/limit；具体会话接口校验 store_id。relations 必须指定完整引用。恢复 POST body 仅允许 store_id；服务重新读取原生 metadata 和已知 active 状态，再使用持久化终端设置调用现有 launcher。launcher 优先聚焦已有 pane，只有新建时才检查物理目录与 CLI；active 会话未匹配到 pane 时返回 409，不重复启动。响应的可选 action 为 focused、new_tab 或 new_window。Codex status 仅代表该 app-server 已知状态，不提供跨进程的全局运行锁。

`terminal-launcher.mjs` 串行处理恢复请求。Otty 按 runtime 与完整 agent_session_id 查 pane，匹配后只 focus，不发送恢复命令；原生发现启动中的短暂空档仅复用本服务刚创建的 pane。无匹配时在 focused window 新建 tab，没有窗口才通过 open 创建窗口并使用初始 pane，不改已有窗口标题。权限、控制接口和歧义错误直接返回，不当作无窗口处理。Ghostty adapter 使用原生 AppleScript 1.3 API，按前台窗口优先新建 tab；无窗口时新建窗口，不额外创建空 tab。`runtime/ghostty-targets.json` 仅保存 runtime、可信数据根、session ID 到原生 terminal ID 的关联，权限 0600、原子写入、最多 256 条，每次定位先核实 pane 存在。它不保存正文，不按目录或标题猜测手动打开的 pane；旧 pane 关闭后重新恢复会新建 tab。Terminal.app 保持原有打开行为。

`session-pin-store.mjs` 使用独立的 `session-pins.sqlite`，仅保存完整 SessionRef 和 pinned_at，不复制标题、正文或运行状态。GET /api/v1/session-browser/pins 返回标记引用，PUT 同一路径接受 {session, pinned}，重复设置幂等，仅真实变化发布 revision。标记前验证来源及原生会话，取消标记无需原生会话仍可读。GET /api/v1/session-browser/:provider/pinned 分页直接读取标记的原生 metadata，不扫描所有历史；workspace/branch 精确筛选，空页保留后续 cursor。不可读会话保留标记及可取消的占位。Pin 与运行状态独立，恢复和服务重启不清除标记。Pinned 视图沿用主子会话树，子会话经祖先补读归入主会话，不提升为独立主会话。

`session-link-store.mjs` 是独立关系存储，使用 session-links.sqlite，仅保存完整父子引用、来源与创建时间。登记使用事务和 child 唯一约束，拒绝自关联、不同父级、反向或间接循环，同边幂等；解除是显式操作。服务在写入前读取原生 metadata 验证引用，并同时检查原生 subagent 与登记关系形成的祖先链（最多 64 层、30 秒预算）。fork 是独立 provenance，不参与协作父子判断。原生关系只读，不写入关系库。children 先分页返回登记关系，再读取原生 children；原生正文失效不删除已登记引用。

Codex timeline的from/to均省略时，scope=session，主读thread/items/list，每HTTP请求最多3页、每页100 item；显式时间窗兼容Turn segments组合分页。bounds返回创建时间start_at、最后一条所属用户/助手消息end_at、end_state及indexed_from。消息时间优先completedAtMs，再用startedAtMs；旧数据缺失时由codex-rollout-timing补读原始记录时间。points不计fork创建前历史、工具或reasoning；无法可靠恢复的末条时间仍保留unknown。

时间缓存仅含item/Turn ID、时间、角色和原生分页锚点，不留正文。消息索引最多50会话、每会话50,000 point/1024 native page、滑动5分钟TTL。updated_at改变后先清除新版本覆盖证明，保留有界精确ID锚点。对已从头读到末尾的完整索引，codex-rollout-history通过可信原生日志路径、同一文件身份与完整旧前缀SHA256验证历史未变，再确认旧末条消息的ID、时间、轮次和角色仍出现在新头部；满足才复用旧时间点。文件最多64MiB，读取时变化、截断、重写或无法证明均重新读取，撤回导致旧末消息消失时也重读；不缓存日志字节。复用结果以可失效的opaque snapshot cursor每次最多300点分页，不将旧native cursor误当成新页位置。按时间定位接受可选item_id，以区分同一时间的消息；原生页移动时用thread/items/read按turnId和itemIds验证目标，不静默替换为相邻消息。未覆盖目标返回SESSION_TIMELINE_INCOMPLETE，前端自动补读时间元数据后重试。coverage区分partial/complete/unsupported；旧CLI的正文定位可回退Turn级，但热力条不伪造消息时间。正文容量限制和媒体占位保持不变。

workspaces返回每个目录可选的去重branch_names，直接从同一100条原生元数据页聚合，不增加索引扫描；跨页分支名由前端去重，未知分支不生成子节点。新增GET /api/v1/session-browser/:provider/branches返回分支名、已观测会话数、去重workspace_paths、session_ids与next_cursor；只读取同一来源的100条元数据页，与目录及列表复用缓存。branch参数按完整名称精确筛选列表与原生正文搜索结果，不向原生接口发送未经支持的分支过滤参数。过滤后的空页保留原生cursor，前端自动继续；分支目录跨页按会话ID去重，绿点由已载入会话ID与live presence匹配。没有分支元数据的会话仍可在全部会话中访问。分页观察器跳过无布局尺寸的占位，观察真实分页标记。

API v5 的 MCP 通过 mcp/src/session-client.mjs 转发已有 HTTP 接口，提供原生会话查询、正文搜索、关系查询及登记，和定时任务 CRUD、启停、立即执行、执行记录与 runtime 查询。新增会话消息控制使用独立 provider/transport 链和持久化回执，详见下文“原生会话消息控制”；完整工具表见 README。修改类工具保留 expected_etag 并发检查，schedule_run 要求幂等键。查询保留游标和搜索范围，不保存另一份对话正文。Task lifecycle、attribution、checkpoint、summary、projection、spool 不再进入运行链路。旧 Task 路由统一 410 TASKS_RETIRED，正常请求还校验客户端 API version；旧插件不能静默继续写入。

MCP 的 session_messages 保持默认 page 分页，并增加 head/tail/all 历史读取模式。head/all 请求 REST messages 的 order=asc，由 Codex 原生 thread/items/list 或 thread/turns/list 正向翻页；tail 使用 desc，所有输出批次内部均按时间正序排列。历史读取游标包含 provider/store/session/mode 作用域、原生页游标与页内偏移，不保存正文。单次聚合限制为 50 页、25 秒与 max_chars；完整性依据历史是否读完及原生/聚合截断标记，不把局部内容称为全部。原生消息方向通过响应 order 校验，旧服务必须先升级，禁止静默把最近页当作开头。

codex-rollout-timing在可展示消息缺少原生时间，或 Teams 需要补回精确消息的 phase/hook 来源时启用。路径来自thread/read的私有path，通过WeakMap传给时间读取器，不公开给浏览器；realpath后必须位于配置数据根的sessions或archived_sessions内。最多读取64MiB文件、单行4Mi字符、50,000条消息；缓存16份时间/ID/摘要与公开消息来源索引、5分钟TTL，文件大小或mtime变化即失效，合并同路径并发扫描。精确role/item ID优先；生成ID仅允许turnId/role/完整文本摘要唯一匹配，歧义保留未知。正文只在扫描时临时解析，不缓存、写库或日志；图表和正文使用同一补齐结果。

可选activity()与live_presence返回store_id、available、sessions及checked_at。sessions为现有共享app-server中已加载会话的规范化元数据，保留state和active_flags；通过CODEX_HOME/app-server-control/app-server-control.sock进行WebSocket连接，分页调用thread/loaded/list，再以最多4并发thread/read(includeTurns:false)读取状态。只发送initialize、initialized与这两个只读查询；不调用resume/start，不启动或终止共享服务器。快照缓存3秒并合并并发；thread/status/changed等原生事件立即失效缓存并发布revision，前端同时每5秒补查。连接失败撤下旧状态并返回available:false，不使用lsof、进程扫描、文件描述符或日志更新时间推断。历史查询仍使用独立stdio连接，不能作为实时状态来源。Unix socket状态读取无macOS平台分支；其覆盖范围是所连接共享服务器，不声称全机发现。

React Sessions仅提供Tree，侧栏目录仅筛选会话树，顶部正文搜索独立使用当前来源的全局范围；二者共用阅读面板。侧栏提供Workspace/Branch两种分组；branch_groups能力控制分支入口，group偏好保存在URL及localStorage。Workspace以workspace为一级、branch为二级，Branch按相反顺序呈现，两者共用可折叠目录树。选择一级节点仅保留该维度限制，选择二级节点同时保留branch与workspace；切换分组保留筛选、搜索与当前正文，自动展开选中父节点，折叠不改变筛选。窄屏选择器提供对应的两级选项。列表查询键包含完整branch与workspace；全局搜索键仅包含来源、关键词和归档范围，请求不携带workspace/branch。SessionSearch只按provider挂载，不因左侧分组、目录、分支或Pin/状态变化重建，保留输入及在途分页。搜索命中可直接打开当前目录之外的会话，不修改左侧筛选。用户改变列表筛选时仍清空预览。目录、会话和更早消息通过IntersectionObserver在滚动边缘自动翻页；正文搜索保留已展示结果并连续请求后续批次，不依赖滚动位置，空搜索页也自动继续。目录计数仅为已观测数量。正文搜索debounce 300ms，在Base UI Combobox浮层展示，选择后按该query定位。搜索使用独立sessionSearch查询键，即使query为空也不与主列表共用查询，避免禁用的搜索observer覆盖列表queryFn、分页大小或缓存生命周期。会话树沿用sessionList查询及原生cursor，底层list接口不受展示视图删除影响。活跃状态独立每5秒刷新，不轮询正文搜索。整页错误仅由来源、根列表、目录或分支目录查询触发，每3秒重试空闲的失败查询，不反复中断慢请求。正文、时间线、子会话、关系与搜索的503/504或超时只影响对应区域，不参与整页重连；搜索失败显示原因，正文失败保留可用内容及其他会话入口。SSE实时状态独立于原生会话查询结果。共享Codex连接按实例处理关闭，旧连接延迟失败不能关闭新连接。内容仅在查询内存中；REST保留JSON字段校验与脱敏边界，不按客户端IP、Host或Origin拦截。

热力/children队列最多4个在途请求，后台任务最多占3个，为显式定位或展开保留位置；排队时用户请求先执行，离屏通过AbortSignal取消等待和HTTP读取并停止继续翻页。共享浏览连接上的HTTP取消不宣称能够中止已经发出的原生RPC；正文搜索把Query取消传到fetch及服务端，停止本次rg或原生回退搜索的专用app-server，终止旧查询。自动分页每次加载后重新验证IntersectionObserver，不沿用插入新内容前的旧可见状态。

## Run output files

React Run detail 使用 `POST /api/v1/runs/:id/files/open`，JSON body 只允许 `{ path }`。接口保留JSON请求类型及字段校验，不按客户端IP、Host或Origin拦截。RunService 从 ledger 读取 immutable snapshot 和 file_changes；客户端不得传 workspace、command 或 application。

文件名在两平台均链接到`GET /api/v1/runs/:id/files/preview?path=...`。入口复用file opener的Run记录及workspace/realpath校验，返回303重定向到`/run-files/:token/:filename`；临时token使用24字节随机值，仅在RunService内存保存30分钟，最多64个，shutdown清空。GET/HEAD资源以入口所在目录为根，校验realpath边界与普通文件类型，拒绝隐藏路径、符号链接越界和未知类型的附属资源；不提供目录列表。静态资源按扩展名返回MIME，未知类型的已记录入口按attachment下载，文件流直接从打开的handle传输，不将正文装入JSON或持久化。不保存历史快照，目录内相对URL保持可用，站点根路径不重写。

预览与现有API均不按客户端IP、Host或Origin拦截。HTML响应使用CSP sandbox且不授予allow-same-origin，脚本仅能读取当前token目录及HTTPS资源；不允许提交表单或作为iframe嵌入。资源响应设置no-store、nosniff、no-referrer和Access-Control-Allow-Origin:*，仅有效token的GET/HEAD路径提供资源CORS响应头，供沙箱内模块、字体及fetch读取资源。Dashboard API不增加CORS响应头。React使用原生target=_blank与noopener noreferrer链接，避免异步window.open被浏览器拦截；已删除文件不生成链接。macOS系统打开作为独立操作保留，Linux只提供浏览器访问。

file opener 要求 path 精确匹配该 Run 的非删除文件记录，相对路径以 snapshot.workspace 解析；路径规范化及 realpath 后均须处于该 workspace 内，且目标必须为普通文件。macOS 通过 argv array、`shell: false` 调用 `/usr/bin/open`，参数为编码后的本地 file URL，使用系统默认应用。未记录、已删除、缺失、越界、非普通文件、非 macOS 或 opener 失败均返回可展示的 typed error；不回写 Run，也不执行 shell 拼接命令。

## Action 定时调度

`scheduler-clock` 在 `daemon` 内根据 wall clock 和 durable occurrence key 计算到期任务。filesystem watcher 负责低延迟 definition change，周期 rescan 提供最终一致性。sleep/wake 可产生 bounded catch-up，但同一个 occurrence key 不能创建两次 Run。

Definitions directory 切换是一个受控迁移：验证目标、迁移/合并、切换 repository、替换 watcher、持久化 config；任一步失败都恢复旧 repository 和 watcher。

## Dashboard views and timeline interaction

Production `daemon` 读取 `ui/dist/react.html`，脚本与样式内嵌。品牌图使用 `ui/assets/undercontrol.png`（豪猪宝宝“刺刺”原图），由同源 `/undercontrol.png` 路由提供，供导航与 favicon 共用，favicon 由页面入口设置；生产服务缓存一小时，页面图像 URL 携带品牌版本参数以避免换图后仍显示旧缓存，开发服务不缓存。构建 adapter 时将同一文件复制到插件 assets，发布包携带这些图片。`ui/dist/index.html` 继续随 release 打包，仅用于回滚和迁移对照，不参与默认路由；source preview 与 installed runtime 因此使用同一 React entry 和同一 API contract。

顶层导航依次为 Sessions、Actions、Teams；Sessions仅保留Tree。SessionsView持有childPages与按完整引用读取的ancestor元数据，通过collectSessionFamily仅遍历当前根列表可达的子页和父链；切换workspace/branch不会混入其他范围的旧子页或祖先，同一完整引用只展示一次。父会话未在当前页时，由SessionAncestorSource通过共用读取队列补读，加载期间显示读取主会话，失败后明确提示父会话暂不可读取。projectSessionTree只允许真实主会话作为一级节点：有原生父级、登记父级或is_subagent标记的会话不能因父级缺失、冲突或循环而升为一级。会话树连接线贯穿同级节点间距及展开的子树，横向连接各子项；末个同级节点在线条接入标题时收尾，不向其子树延伸祖先竖干。连接线只反映已展示的真实层级，不可点击。选中已读取子会话时按祖先路径自动展开，用户手动折叠不会因状态轮询重新展开。collectSessionRelations合并原生metadata与登记边并按端点去重；indexSessionRelations分别索引parents/children和forkSources/forks，fork永不参与父子树构造，正常fork仍作为独立主会话。标题行合并Subagent/协作标签、子会话及派生Fork数量与来源入口，数量只代表已发现的直接关系。Fork来源显示forked from标题或短ID；Codex created_at可确认时追加at时间，表示新fork会话创建时间，不用复制历史的首条消息或updated_at推算。原生时间来源见[rollout recorder](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs)与[thread summary](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/thread_summary.rs)。关系浮层使用Base UI Popover，点击按完整provider/store/session引用读取；Escape关闭并恢复焦点。详情关系面板合并当前已发现的边，支持从来源查看派生Fork。

Cards与List均已退出产品入口。Sessions主布局只含350px侧栏和会话树两栏，列表项仅有title与subtitle，不再提供横向热力条；subtitle从左至右为branch、workspace，共用text-secondary语义色。会话读取复用Base UI Dialog的container portal、keepMounted和modal=false，以右侧悬浮Sheet覆盖页面，不占grid列，不改变列表宽度。Sheet桌面宽640px、窄屏自适应；条目标题按钮的点击区域覆盖整个item，展开、Pin、关系和终端操作保持独立。选中项仅用背景与边框区分，不绘制左侧标记。Sheet具备边框、圆角与投影，打开时聚焦Sheet本身，关闭不恢复标题焦点。右上角X按钮、外侧空白点击或Escape均可关闭；页面外侧仍可操作。关闭保留正文DOM、已读消息和滚动位置，并停止选中时间轴的继续分页；重新打开恢复原阅读位置。窄屏Sheet占据视图并保留右侧minimap。UnderControl 2.0使用统一深色语义变量、本地Geist字体及Motion交互；不改变Session业务规则。


当前对话minimap轨道宽12px，与旧横向条桌面高度一致；图例放在对话标题下的时间行，不挤占轨道。正文隐藏原生滚动条而保持overflow滚动与键盘焦点。minimap使用该会话独立的起止范围，不再使用全局7天或日/时/分切换，不聚合项目曲线。secondHeatCells按真实UTC秒分别统计user、assistant及未知事件，空秒保持稀疏。时间从minimap顶部向底部推进；Canvas以绿色表示用户、紫色表示Agent，同秒或同像素重叠时左右分色，分别保留各角色的最高每秒密度。悬停提示与aria-valuetext包含角色计数。时间索引由SessionDetail唯一持有，列表不挂载TimelineSource、不为每行预读时间点；选中后连续读取原生分页，Sheet收起后暂停。范围、时间标签、颜色图例、当前阅读游标及可视消息时间窗口均在对话中展示。SessionChildrenSource与SessionAncestorSource继续复用最多4并发的sessionReadRequests，不改变父子会话规则。

悬停从pointer事件直接安排requestAnimationFrame，连续移动时每帧取最新目标，同一消息ID/时间不重复定位；精确ID避免同时间消息互相覆盖。尚未读取的秒只显示时间，不显示虚假的0条或阴影说明；可见会话继续自动补页，读到悬停区域后自动定位。pointer capture支持触屏/拖出行，上下方向键切相邻消息、Home/End跳首尾。正文按当前已加载消息的ID与时间直接定位，不改变查询键；只有目标不在当前页时才读取。慢读取期间保留最新目标，完成后先检查返回页能否满足新目标，再决定是否继续查询，不因每次鼠标移动取消在途读取，也不把旧请求的匹配标记用到新位置。不增加跨窗口正文缓存，gcTime仍为0。滚动使用约100ms的可转向缓出动画；手动输入及更早分页锚点维护取消动画，reduced-motion直接定位。手动滚动暂停内部跟随，下一次热力条操作发出followRequest自动恢复，不提供恢复按钮。

垂直minimap位置保持稳定，hover不滚动会话树；最近消息重新请求原生head。正文定位仅在conversation容器中用动画帧插值更新scrollTop，原生scrollTo使用instant避免叠加浏览器动画；减少动态效果时直接到目标，手动阅读立即停止自动滚动。正文scroll事件经requestAnimationFrame读取视口中线对应消息，回传原生消息ID和时间。非悬停时，横向游标、时间提示与三角统一使用readingAt，键盘焦点和旧selectedAt不能覆盖正文位置；悬停/拖动临时显示预览位置，离开或结束后恢复实际阅读位置。回传不能发起seek或重读请求，避免双向循环。普通阅读首次滚到最近消息，向前分页仍用原可见消息DOM位置校正。历史Markdown为static，Actions行为不变。窄屏通过sheet在会话树与全宽阅读之间切换。

UI验收需覆盖真实会话数量、标题长度和时间分布；截图可匿名化文字，但不能只靠少量规整fixture判断产品效果。首次悬停、清空后重开、连续浏览、加载更早历史须检查鼠标下方布局与阅读位置是否保持稳定。

## Compatibility and migrations

Scheduler schema v4 是当前 unified Run ledger。v1–v3 tables 只保留在 migration code 中用于升级已有数据库，不得重新成为 active execution path。

历史 Task schema 与生成资产只供历史对照；当前不提供 Task import/migrate，不打开旧库，也不启动旧文件重建。Session links schema v1 独立于 Actions schema。

安装或卸载时可以清理由 UnderControl 明确拥有的旧 per-Schedule LaunchAgents；cleanup 必须验证 owner、mode、symlink 和 canonical program path，无法确认的文件 fail closed。

## Verification gates

```bash
npm run build
npm run build:adapters
npm run check
npm test
git diff --check
```

架构变更还必须证明：

- Markdown → due occurrence → queued Run → CLI → terminal Run 的 integration test；
- runtime resolution 卡住时 cancel/shutdown 能及时完成；
- missing runtime/model catalog 返回 typed state，不返回 missing route；
- release artifact 包含 registry、adapter、Run service 与 migration，且不包含 legacy scheduled runner；
- source Dashboard 与 daemon API version/capability 不兼容时显式失败。
- fake app-server E2E 必须覆盖 Run-specific SSE、mouse steer、Stop、terminal authoritative refresh 与 CLI-owned conversation read；runtime `turnId` 和 guidance 不得进入 Run response、SQLite 或 logs。
- Schedule capability E2E 必须覆盖 Markdown/REST policy、immutable Run snapshot、integration argv overrides、Skill thread config、mixed policies与 Web Search 不受影响。

### Schedule Fast mode

Action Markdown 与 CRUD API 的可选 `fast_mode` 为 boolean 或 null，仅 Codex 支持显式 boolean。省略/null 继承运行时默认，true 开启，false 使用普通速度；旧 definition 无需迁移。Run 沿用完整不可变 snapshot 保存选择。Codex interactive adapter 将显式值映射为 `turn/start.serviceTier` 的 `fast` / `default`；CLI invocation 对应 `-c service_tier="fast"` / `"default"`，继承时不传覆盖值。不要用降低 reasoning effort 实现 Fast mode，也不要修改用户的全局 Codex 配置。

### Codex 临时失败恢复

Codex 返回 `thread <id> already has an active writer`（JSON-RPC -32600）时映射为 `RUNTIME_SESSION_IN_USE`。Run 以失败结束，界面提示退出占用会话的客户端后重跑；此错误不属于模型/网络瞬态重试，不接管其他客户端，也不回退新建会话。

codex-interactive-session 在已确认的 turn/completed.failed 后读取 error.message 与 codexErrorInfo，必要时使用同轮 error 通知补全诊断，不再将所有 provider 失败折叠为 RUNTIME_PROCESS_FAILED。容量不足和限流使用独立错误码；未知失败仍保留泛化错误。

同一个存活的 app-server、Thread 和 Run 中最多新增 3 个恢复 Turn，延迟 10/30/90 秒并增加最多 20% jitter。恢复输入只请求继续未完成工作，保留原 model、effort、serviceTier、workspace、sandbox 和已确认文件变更。RunService 仍只启动一次、持有一个 completion；原 occurrence 防重与 single-active-run 约束不变。重试期间不写终态、不重置任务总超时，也不重新提交初始 prompt。实时流复用 activity_started/completed 和递增 Turn revision，日志只记录有上限的 provider 错误与重试元数据。

非只读 item 尚未完成或失败结果不确定时不自动继续。RPC 超时、IPC 关闭和进程退出不被当作可安全重放的模型错误。取消、任务超时和 shutdown 同时清理 retry timer；Stop 在 backoff 中验证旧 Turn revision 后直接结束 Run，不向已结束的 Turn 发 interrupt。旧 turn/start 响应不得复活已进入 backoff 的 Turn。OpenCode 不进入此恢复链路。

### Codex 连接关闭

App-server client 的 `onClose` 是一次性生命周期通知，覆盖无 pending RPC 时的进程退出、pipe error 与主动关闭；晚订阅者立即收到已保存的关闭结果。启动未完成时关闭也必须拒绝 `started`，不能留下无限等待。Interactive session 在启动请求前订阅，完成时退订，异常关闭立即 settle 为 failed，保留数字 exit code、已有 session ID 和已确认 file changes；不把原始 stderr、RPC payload 或未完成回复写入错误字段。主动取消与正常 Turn 完成先 settle 再关连接，避免被错误覆盖。RunService 沿用 terminal persistence 与 SSE 更新界面。


### Schedule network access and recovery

可选 `network_access` 为 boolean/null，仅 Codex 支持；缺省继承。Markdown、CRUD、Run snapshot 与两个编辑器必须保持 true/false/null 的语义。Interactive adapter 在 `thread/start.config` 传递 `sandbox_workspace_write.network_access`，CLI 路径传递对应 `-c`；不改变审批策略、全局配置或其他任务。该原生键仅影响 workspace-write 的 shell 网络策略。

`RunService` 在 normalized `session` 事件到达时立即调用 `RunStore.recordSession`，而不是等待终态。完成、取消、超时与异常分支保留已知 session；restart recovery 仍将 open Run 标为 interrupted，不自动接管进程。UI 仅终态允许 Terminal Resume。

Dashboard SSE 的 changed/open 必须使 schedules（含运行历史）和 runs（含详情）查询失效，并沿用 2 秒合并窗口。Live SSE 重连保留 cursor 和草稿，reset 后清除旧 cursor；连接丢失或恢复时补读 authoritative Run，使遗漏终态也能关闭 stream。客户端最多保留 500 条实时条目；完整对话仍由 Codex-owned session 提供。

Cadence 输入校验错误返回 `SCHEDULE_INPUT_INVALID`，不能暴露为泛化 500 错误。

已到期的一次性定义仍须可读取、编辑与查看运行历史，不能因时间流逝变为 invalid。读写 codec 允许过去的 once 时间；新建或明确修改 cadence 的 API 仍要求未来时间，调度防重由持久化 occurrence 负责。

历史对话优先使用原生 `thread/items/list`（倒序分页，每页 8 条，最多 128 页），仅保留 user/assistant messages 后按时间正序展示。字符总量仍限制为 1 MiB，达到页数或容量上限必须标记 truncated；不落盘工具输出。仅旧 CLI 明确返回 method-not-found 时退回有 16 MiB 上限的 `thread/read`。

Run SSE 每 15 秒发送 comment 保活，关闭 response 时同时清理 timer 与订阅。开发代理必须立即转发响应头，不能等下一条事件才让浏览器进入 connected。全局变更只刷新 Run 元数据，避免反复启动 CLI 重读终态对话。

### OpenCode runtime

`opencode` adapter 复用 Registry、RunService、Scheduler 与 ledger。每次 Run 启动只监听 loopback 且随机 Basic auth 的原生 `opencode serve`；HTTP 提交 prompt/abort，SSE 提供即时事件，状态与最近消息轮询用于恢复断线期间遗漏的结束事实。用户消息 ID 使用原生 ascending 格式，最终回复必须匹配当前 prompt 的 parentID，工具调用步骤不能视为任务完成。实时流过滤用户文本与 reasoning，不持久化 SSE 原文。

OpenCode 不支持 OS sandbox 或独立禁用 Skills/MCP。定义与执行边界都拒绝非 `danger-full-access`、禁用扩展能力以及显式 Fast mode/network policy；模型为 provider/model，reasoning 字段保存原生 variant。权限询问和交互问题结束 Run 并保留 Session；不自动扩大工具权限。取消和超时先调用原生 abort，再结束自己创建的进程组。

历史读取使用原生消息接口，最多 100 条、1 MiB 文本；已结束 Run 的 Session ID 是 Terminal Resume 入口，恢复前验证 Session，再用已解析的 executable 与 `--session` 参数启动。Session ID、workspace 与 runtime ID 均取自可信 Run，不接受浏览器构造命令。服务 stdout/stderr 写入有大小上限的私有 Run 日志；stdout 只追加工具名、OpenCode 给出的标题或脱敏命令摘要，不记录工具参数或结果正文。provider 错误在 Run final message 中保留有上限的可读原因，并使用稳定错误码区分类别。

## 原生会话消息控制

`POST /api/v1/session-control/compact` 与 MCP `session_compact` 复用 SessionMessaging 的 provider/store 校验、per-session lane、请求 fingerprint 和持久化回执。compact 不要求 expected_turn_id，也不主动 interrupt；忙碌会话明确拒绝。Codex resume 订阅指定线程后调用 thread/compact/start，RPC 成功仅为 accepted，contextCompaction 完成通知才置 completed=true，session_delivery 可刷新该状态；不支持自定义指令、CLI 文本伪装压缩或未知结果后的跨通道重发。Claude SDK/CLI 只在空闲的 owned worker 或安全 resume 后发送原生 /compact，并以 compact_boundary 确认完成，用户消息回显不算压缩完成。服务重启后保留原回执，不把丢失的完成通知推断为成功。

`server/src/runtime/session-messaging.mjs` 负责验证完整 SessionRef、请求去重、会话级串行与通道调度；`session-messaging/providers` 各 provider 实现原生能力，通用调用失败不能直接当作未发送。每个操作筛选并顺序调用支持该动作的 transport，仅 delivery=not_sent 且 fallback=true 才降级。未知异常、写入后超时及断线保持 unknown。

Codex 使用明确授权方法列表的共享 app-server 客户端；状态读取客户端默认仍是只读。原生 queue/steer/interrupt 优先，CLI queue 仅是 queue 的备用实现。Claude SDK 和 stream-json CLI 通过相同的受控 worker 语义接入；恢复前验证 transcript 的 sessionId/cwd、数据源与原生 agent 目录，不创建与外部活跃进程并发的 worker。Otty 最后通道仅做明确匹配的 queue，不承担无条件打断。

`session-messages.sqlite` 由 daemon 独占，保存请求指纹、投递阶段及回执，不保存消息正文。初始化时 sending 变为 unknown；同一请求 ID 的目标、文本和操作不可改变。只读核对能证明原生接受时更新回执；未找到记录不构成失败证据。MCP/HTTP 都使用同一控制服务，工具列表及示例见 README。

Claude 从用户回显或回复流的 user_message_uuid/user_message_uuids 确认对应输入，忽略迟到的重复回显，同一轮消费的合并输入一起结束；打断必须收到指定受控轮次的 aborted_streaming/aborted_tools 结果，普通结束不视为打断成功。没有对应消息 ID 证明时保留 unknown，不凭队列文本推断。

Claude SDK 随 server vendor 构建并保留 Anthropic LICENSE；原生 CLI 仍由可执行文件 resolver 定位。关闭时先释放控制连接、等待在途投递记录收敛，再关闭回执数据库；空闲 worker 定时释放。


## Working windows and minute intervals

Cadence 增加 `interval`（整数 `minutes: 1..1440`）。非 once cadence 可带 `work_hours: { weekdays, windows: [{start,end}] }`；Markdown 与 HTTP/MCP 使用同一结构，weekdays 为 ISO 1..7。集中在 `scheduler/cadence.mjs` 校验时间、范围、重叠及固定时刻可达性，codec 只转换原有 human cadence 字段。Run snapshot 保留整个 cadence，不增加数据库列或第二个调度状态表。

窗口为同一天内的半开区间，end 允许24:00。无窗口的 interval 对固定经过时间网格取整；有窗口则从各段本地起点按经过分钟计算，起点和日期由服务本机 Date 语义决定。nextOccurrence 与 latestDueOccurrence 共用窗口规则；latestDueOccurrence 在关闭时段返回null，在开放时段将补跑下界截到当前窗口开始，避免重放上个窗口或周末积压。原有 occurrence key 和 Run 唯一约束继续防重，30秒调度节拍及正在执行任务的互斥行为不变。

生效时段只限制自动调度；已启动 Run 的执行及其已有内部重试继续完成，手动 Run 不受限。前端创建/编辑、列表摘要与 MCP schema 同步支持；网页新建周期计划默认周一至周五07:00–18:00，直接配置生效时段并写入work_hours，不再使用启用开关。旧计划未设置work_hours时回填全周全天，未编辑时段时仍不写入work_hours，以保留原始interval时间网格；编辑星期或起止时间后才按所选值保存。Legacy 回滚界面可以显示新摘要，但拒绝编辑含 interval/work_hours 的计划，防止静默退化为 daily 丢失约束。

## Frontend component architecture

`ui/react/app` 管理 shell、导航、连接与设置；`features/sessions`、`features/scheduled` 和 `features/teams` 分别保存会话、定时任务与团队业务；`components/agents` 提供 Teams 和 Sessions 共用的成员身份展示；不为目录外观拆散业务文件。共用控件集中在 `components/ui`，Kibo 源码组合组件集中在 `components/kibo-ui`，注册表与来源记录见 `components/registry/README.md`。`lib/cn.ts` 为唯一 class 合并入口，`lib/motion.ts` 定义 150/220/300ms 动效约定。

Kibo 是 shadcn 生态的源码注册表，扩展组件以它为默认来源；按钮、表单、Dialog、Sheet、Select、Popover、Tooltip 和分段切换采用 shadcn 组件组织和属性约定，交互底层只使用 Base UI。React Aria/dotUI 组件、跨框架 Drawer 桥接以及专用 Tailwind 插件已退出当前 React 前端。Kibo Status/Pill/Spinner 只纳入用到的导出，使用同一语义颜色，不为导出未使用的 Avatar/Gantt/装饰效果安装依赖。AI Elements/Streamdown、Canvas minimap 和已有 SSE/Query 业务代码继续使用；旧版回滚构建仍依赖 SVAR，不能删除。

`styles/tokens.css` 是唯一颜色、字体、间距、圆角、阴影和 CSS 时长定义；`styles/components.css` 负责共用控件，功能布局保留原有位置。MotionConfig 遵从系统减少动态效果，LazyMotion 使用 domMax 支持布局投影。Motion 负责导航选中、弹窗、Sheet、列表重排和展开反馈；hover/focus/disabled 等即时控件状态使用相同 CSS 时长。实时状态不添加装饰性循环闪动。现有产品没有 toast 或独立 Overview，不为本次改造新增这些工作流。

Geist Sans/Mono 的拉丁字集 WOFF2 随 esbuild 以 data URL 内嵌，中文沿用系统字体。React 编译器保留这些本地 @font-face，继续拒绝远程 CSS URL，产物仍为离线单 HTML。React 与 Tailwind 版本不迁移。检查使用 npm run check、npm run test:ui、生产构建及相关 node:test；仓库未配置独立 linter，不能把跳过 lint 说成 ESLint 通过。

## Agent Loop 团队协作

源码合同见[Agent Loop 架构与接口](agent-loop.md)。同一 daemon 在 scheduler.sqlite 中添加独立版本的 loop_* 表及 execution_resources，Actions 使用既有 scheduled_runs 表，新增独立外部触发接口，旧 schedules 管理路径保持兼容。daemon 持有共享 SQLite 连接并最终关闭，RunStore 不关闭外部注入的连接。RunService 与协作运行时共用 agent-execution 和底层 supervisor，不互相包装。

团队以用户消息建立内部任务，Leader 按依赖委派成员并根据回报继续工作。 Teams 工具、协作执行详情及历史过程展示采用 shadcn/ui Base UI Trace 组合，参数与结果按需展开；reasoning、tool、正文继续按真实事件顺序展示。Teams 消息、滚动和输入已使用官方 shadcn Message/Bubble、Message Scroller 和 Input Group，代码块使用 Code Block，摘要流式效果使用纯 CSS shimmer；剩余定义、来源及附件业务适配继续复用；不引入 AI SDK 执行或第二套组件运行时。消息、持久 inbox、outbox 及后续派发使用事务。Agent 定义来自本地全局目录、ECC 或 Agency Agents 在线目录；市场来源由服务端返回，目录按来源独立缓存并可手动刷新，定义和导入记录固定到具体 commit。市场导入原子写入真实共享 Agent 目录后才允许加入团队，成员执行配置与定义快照分别保存。Teams 看板保留 loop_boards、loop_work_items 和 revision 保存人工记录；board/conversation-work.mjs 从已有 Task、inbox、Run、消息及版本化报告生成只读会话卡片，无额外数据表或模型调用。卡片关联原工作，成员续接不按 Run 重复建卡；普通消息和提问不另建卡片，相关问答进入工作详情。状态区分排队、目录等待、执行、阻塞、报告交付与验收结论。人工排序接口仅接收人工 ID，会话卡片不允许伪造状态；Task 事件和全局失效通知刷新看板，人工 revision 不承担执行版本。协作 loop_schema 为 7，Actions Run user_version 为 5。六个 Run 专用 MCP 工具为 read_context、remember、send_message、submit_result、request_action、report_progress。成员续接自己的原生会话，按成功投递游标读取新增输入；完整历史通过有界分页工具读取，关键决定及摘要保留来源。SQLite 保存共享事实、执行索引和未导出版本；服务管理的资料目录异步备份完整团队与文件快照，失败不阻断协作。团队只需名称；服务为新任务分配稳定内部目录，独立新应用可直接在内部目录实现，已有项目和分支由 Leader 根据任务及已有上下文通过 prepare_projects 为当前任务准备，不校验路径字符串是否出现在某一条用户消息中，也不要求重复确认；恢复不重放旧执行。旧固定阶段记录继续按原流程执行，新聊天使用 conversation 工作流。

新任务的 CLI 始终使用服务管理的内部目录。项目执行可选择隔离新分支、继续已有本地分支或明确复用原目录，记录实际目录、分支、起点及 dirty 状态；按实际 resource_scope 原子取得所需目录占用，目录等待不占运行名额。Teams 的 Codex 在新建、恢复线程和每轮执行中使用完整访问，不再按角色限制到工作目录白名单；不修改客户端全局配置、Actions 或旧固定阶段任务。项目绑定可在同一任务显式更新，并保存稳定 Git 管理目录与相对路径；执行前后刷新改名或移动后的分支和 worktree，保留项目顺序与原生会话。Leader 按任务检查真实实现与验证证据，不强制独立验证 Run；未结束成员仍需完成或明确处理。暂停或改目标撤销 Run 凭据，重启不重放已领取的执行。PID 未知或旧进程仍存活时，不释放目录占用。当前 Codex 消息驱动交付已实测，Claude 讨论与审阅适配仍缺少模型侧成功证据，不开放 Claude 实施。

这是 UnderControl 0.17.0 的实现约定，既有安装版需要手动更新。验证范围见[实施验证记录](job/agent-loop/03-phases.md)。


Teams 成员的 name/avatar 是团队身份，execution_config 保存模型与实际支持的 effort。用户显式 @ 直接派发，无收件人时由 Leader 承接；成员结果交回实际请求者，只有需要协调才通知 Leader。Teams 观察性审查允许并行编辑，实施按声明项目使用排他占用，Leader 统筹不因身份独占项目；depends_on 依赖完成后才派发。公开摘要、工具输入输出及状态保存在 Run.parts，图片/PDF 为服务端路径引用，详见 [Teams](agent-loop.md#成员身份运行内容与生命周期)。loop_schema=7 增加消息关联、投递与处理状态，保留版本 6 的历史成员快照和独立全局定义删除日志。团队成员菜单只移出当前团队；本地 Agent 目录才删除全局定义文件，所有团队成员继续使用定义快照。删除文件先确认 digest，暂存后按 staging/committed 日志恢复或清理；旧成员删除日志继续恢复。解散先停止本团队执行，保留历史，不改变其他团队。

Teams 对话采用官方 shadcn Base UI 的 Message、Bubble、Message Scroller、Input Group、Code Block、Trace 与 shimmer；Reasoning、Tool、Task 和自动续轮组合复用 Trace，InlineCitation 保留真实来源适配；当前任务通过专属 SSE 接收规范化片段更新，初始和重连使用持久化快照校准，连接建立后停止任务级整份重查；约 180ms 的片段持久化批处理保留。Codex 公开 reasoning 请求 detailed 并保留分段，Token 与文件路径/状态同步，文件 diff 和原始推理不进入此链路。Tiptap Mention 继续使用稳定成员 ID。Agent 组件展示定义快照与配置，不接管运行时。导航顺序为 Sessions、Actions、Teams；当前页面与接口使用 teams，旧 rooms 链接和接口保留已有数据兼容入口。团队解散/删除入口位于左侧列表；删除隐藏列表记录并保留原生会话及历史。

Sessions 通过 daemon 注入的 projectSessions 补充团队身份，不跨服务调用协作运行时。新执行按 provider/store/session 精确关联；旧记录额外核对 workspace。列表按团队分组，标题采用用户任务名，成员头像与别名来自当前成员或 Run 快照；原生父子与 fork 关系不变。具体数据约定见 [Sessions 中的团队关联](agent-loop.md#sessions-中的团队关联)。

团队快照将原有 agent_message 事件中的动作补充为 messages[].intent，界面不显示指派、验证、回复或广播的独立用途徽章，接收人直接置于正文行内，并保留稳定成员 ID。此投影不改变派发、权限或消息正文；旧记录缺少事件时不推断动作。独立新产物不以缺少现有仓库路径为阻塞，已有项目目标从任务及已有上下文解析，不以消息原样包含路径作为准备条件；验证方式由任务需要决定，不再以额外验证 Run 的 pass 作为固定门槛。

左侧团队菜单的“复制房间”通过 POST /api/v1/teams/:id/copy 复用当前成员快照及配置，事务内生成新房间和成员 ID 并重映射 Leader。服务为其分配独立默认存储；消息、任务、会话、看板、项目绑定与原团队执行状态不复制。复制不探测 CLI、不重新导入全局定义或启动 Agent；request_key 防止重试产生多个房间。

Teams 对话按动作首次观察时间合并文字、工具、公开摘要和带成员 ID 的消息，保留并行成员的交错顺序；连续同作者只共享显示头，不改变事件顺序。Run.parts 新增首次/最近时间及原生序号，历史 Codex 时间由公共组装层注入的只读时间适配器按精确 item ID 补充。适配器复用 inventory 和有界 journal 扫描，校验数据根目录及 Session/store 身份；时间缺失的历史内容单独标记，不用 Run 创建时间代替。仅连续同作者且同 Run 的公开摘要和工具片段收拢为可展开的过程，正文、真实提及或其他成员插入立即分段；流式过程中展开并保持已打开内容，结束不突然收起；历史默认收起，保留用户选择。正常内容不按整轮重排，@ 接收人直接显示在对应消息正文。结果控制回执不生成临时聊天占位；hook 续轮正文按原生来源折叠，不伪造收件人。SSE 忽略旧序号快照，断线保留已展示片段，REST 与重连合并不改已知首次时间。


结果通过当前 Task 的精确 source_run_id 读取完整已保存公开正文，避免 UI 可见而其他成员只收到尾声。续接输入保存结果事件游标，仅补充新结果与有界索引；未改变的定义不重复注入。reply 与完成通知合并交接，仅恢复需要继续原工作的实际请求者，不为每条完成确认再次调度 Leader。Leader 的 wait 不阻断未结束成员：排队或运行中的成员存在时 Task 保持 active，结果继续被接收；确实只剩用户输入时才进入 waiting。显式暂停、取消和修订的凭据撤销保持。conversation 恢复时保留未启动指派并更新其 generation，与恢复后的 Task 一致；不重建其 Run ID 或重跑已完成记录。Teams Codex 完整访问与角色调度分开，保留全局 hooks 和真实目录锁；Codex Skills/integrations 及未显式指定的网络策略继承客户端配置，不额外关闭。Teams 原生成功不强制 submit_result，公开答复可按 Run ID 读取并返回委派者，不伪造结构化验证。conversation 不再按默认 24 轮或 600 秒截断，旧固定阶段和 Schedule 的显式限制保留。

### Teams Agent 管理与 Marketplace

全局 Agent 配置位于 view=teams&team_view=agents，由 App 将 MarketplaceView 注入 TeamsView 组合；feature 之间不互相导入。成员 + 仅选择本地角色，再配置团队身份。发现、安装、更新、来源和全局定义删除与成员添加/移出分离。

agent-marketplace 下的 GitHub 来源、Markdown 解析、SQLite store、安装服务、Runtime 能力模型与 HTTP 处理各自分离。Daemon 复用 executionDatabase，托管原文位于 dataDirectory/agents，安装有固定 commit/digest、操作恢复日志和本地修改备份。additionalLocalDefinitions 由组合层注入既有 Agent Catalog，使托管角色进入现有 Teams 执行链，成员持有版本快照，不新增执行器。独立 Session 创建仍缺少公开接口，界面明确禁用。详见 [Marketplace](agent-marketplace.md)。


Teams 成员在同一任务版本和客户端内跨讨论、实施、验证续接原生会话，明确修订任务或更换客户端才重新开始。委派在现有 inbox/routing JSON 保存来源消息、请求者、预期产物与验收要求，结果可按 source_run_id 读取完整交接信息。同一请求者、收件人和任务版本的完全相同未完成委派复用原 inbox，保持实际请求者的结果通知；回执指纹与复用关联保存在 loop_events，重试不创建重复消息或执行。比较包含用途、依赖及产物要求，不引入语义相似拦截、固定冷却或执行上限。


Teams 共享记忆在 SQLite 中按当前任务决定与本轮指派关键词筛选，以 12,000 字符限制注入量，原文按 ID 读取。显式 supersedes 关系保存到已有 memory_recorded 事件，旧内容保留。恢复工作进度直接由 Run、inbox 和进度事件重建，保留原状态、来源和未完成事项，只在新会话或恢复时默认注入；正常续接不重复发送。成功执行不转换为业务验收完成，取消不自动重跑。上述资料随现有团队快照保存，不增加数据库、后台模型调用或执行限制。


### Teams 消息、报告与证据

collaboration/store/communication.mjs 管理既有 inbox 的投递、处理及回答关系。ask、reply_to_message_id、assignment_id、answered_message_ids 区分消息接收与问题关闭。Codex 通过既有交互句柄 steer 补充输入，结果不明先只读对账，不另建 Run 重发。独立协调容量和等待老化调度位于 collaboration-runtime.mjs，资源检查先于运行容量领取。

collaboration/store/reports.mjs 使用 loop_events 保存唯一报告及版本，Hook 记录与正式报告分离。完整正文按 ID 读取，恢复摘要使用正式报告。collaboration-runtime/evidence.mjs 记录开始和结束 Git 指纹、显式证据读取时间与内容哈希，提交和退出时检查所引证据。变化只标注结论的版本边界，不禁止编辑。collaboration/store/metrics.mjs 分开计算排队、资源等待和模型等待，按原生 Session 去重累计 Token。字段、上限和示例见 [消息处理与工作交接](agent-loop.md#消息处理与工作交接)。


### 协作约定与通知计划

context.mjs 把所有成员的协作约定、稳定角色、当前工作、运行环境及工具语义分别组织。Leader 保留技术判断与验收职责，不重复成员已有工作。progress 仅进入内部事件；send_message 和 submit_result 回执明确通知去向，退出前的接收人只是计划，不是投递成功。

conversation.mjs 的 reportNotification 同时用于工具回执和退出后的交接，Leader 回答问题也使用该路径。报告按稳定 inbox ID 投递到实际请求者，保留其原工作关联；运行中的 Codex 可接收报告引用及有界摘录，全文按 ID 读取。store 的续接输入排除同一原生 Session 已确认收到的结果。Runtime 无此能力时保持待投递状态，不伪造 inject 接口。详见 [提示词与工具通知回执](agent-loop.md#提示词与工具通知回执)。
