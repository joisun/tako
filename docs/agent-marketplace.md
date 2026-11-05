# Teams · Agent 管理与 Marketplace

在 Teams 左侧底部点击“Agent 管理”，管理所有团队共用的角色定义。地址保持 `/?view=teams&team_view=agents`，`market_tab` 可指定 `local`、`discover`、`installed`、`updates` 或 `sources`。顶层导航仍为 Sessions、Schedule、Teams。

团队成员区的 `+` 只打开可搜索的本地角色选择器。选中后才显示当前团队的名字、头像、运行客户端、模型和 effort 配置，确认后加入团队。选择器不导入、不删除定义，不读取市场网络目录；角色管理与成员配置分开。已加入的角色不可重复加入，失败保留成员配置，返回选择器保留关键词。

## 审计与实施依据

工作区为 feature/agent-loop，已有未提交的 Teams、时间线和成员管理改动，保留其行为。React 19、TypeScript、TanStack Query、Tailwind 4、Motion、Base UI/shadcn、Kibo 和 Streamdown 已具备，本功能没有新增或移除依赖。页面沿用现有 DashboardView、URL 参数及 QueryClient。App 负责组合 Teams 与管理页面，通过 ReactNode 注入，两个 feature 不互相导入。

原有 agent-catalog 可以读取本地全局定义及导入 Agency/ECC，但列表元数据来自路径，且没有独立的托管安装、更新审核与版本登记。Marketplace 增加 GitHub 来源适配器、Markdown 元数据解析及安装服务，复用既有 SQLite 连接、Git、YAML、Runtime 探测和 UI 组件。没有新增数据库文件、全局配置或执行器。

实施顺序为来源和解析、托管安装、发现与详情、更新审核、Runtime/Teams 接入、测试与浏览器验证。初始方案在实现前记录；用户随后明确将管理入口限制在 Teams，并把成员 `+` 改为“先选角色、再配置身份”，当前实现以该要求为准，不增加顶层 Marketplace tab。

## 定义与来源

Agent Definition 保存角色身份、职责、工作流和指令；它不是 Runtime，也不是 Session。安装仅保存定义，不启动模型，不安装其声明的工具、依赖或脚本，不授予额外执行权限。

默认来源按顺序为 Agency Agents（msitarzewski/agency-agents）与现有 ECC（affaan-m/ECC）。来源配置独立持久化，可新增 GitHub owner/repository、分支和可选角色目录，停用或移除。Agency 默认扫描仓库中的角色定义；ECC 默认只读 agents，避免把具备 name 元数据的 Skill/Rule 当作 Agent。目录范围属于来源配置，新增仓库无需修改核心发现代码。不允许把已有来源 ID 改指向另一个仓库；有安装引用时须先停用或卸载，不能移除来源造成关联丢失。没有安装引用的默认来源被移除后，不会在重启时自动复活。

来源适配器通过 HTTPS 读取 bare Git 快照，不 checkout、不运行 hooks、过滤器、仓库脚本或子模块。固定 commit 后按 Git tree 的普通 Markdown blob 读取，不跟随仓库内符号链接。使用 GitHub HTTPS 仓库地址白名单与参数数组，不拼接 shell 命令；来源仓库、分支、路径及 blob 大小均验证。Git 操作有超时和输出限制，使用 blob 大小过滤，最多解析 1500 份、总计 32MB 的候选内容，单份上限 256KB。需要本机 Git；缺少 Git、网络或分支不可用时明确报错。使用只读 Git 是因为审计时 GitHub API 已限流，但 Git HTTPS 可用。

名称、简介、标签优先使用真实 front matter；分类可回退到实际目录，缺少简介时仅提取原文段落。职责和工作流从 Markdown 标题节提取，未提供时保留完整定义供阅读。发现要求角色 name/type 元数据或明确的角色开场/Agent 标题；README、贡献指南及不可识别的 playbook 不作为角色。解析失败逐文件记录；不维护小型示例名单，不把目录名冒充简介。Metadata 有长度限制，原始 UTF-8 Markdown 和 CRLF 不改写。

每个定义关联来源、仓库、文件路径、commit、内容 SHA256 及实际 LICENSE 原文。没有 LICENSE 时显示未提供，不猜测许可。当前 Agency commit b37b5bb33b78f2c1d6567d98e25ca818e3259219 验证得到 283 个角色，包含 12 个 Security 角色；数量来自本次扫描，不写死在代码中。

缓存保存到现有 SQLite，成功目录有效期 10 分钟，同来源并发刷新合并，支持手动刷新。失败时保留上次真实缓存并标明过期/错误，不伪装成最新成功结果。来源没有声明 featured 时不制造精选名单；最近发现指本机首次发现时间，“来源最近提交”是仓库 commit 时间，不声称每个文件都有独立更新时间。

## 安装、更新和卸载

复用 scheduler.sqlite，独立维护 marketplace_schema、marketplace_sources、marketplace_installed、marketplace_operations。Marketplace schema=1 不改变 Scheduled 的 user_version 或 Teams 的 loop_schema。

安装文件位于 UnderControl 数据目录 `agents/installed/<稳定哈希>/definition.md`，逐字保存来源原文，权限 0600。稳定标识由来源 ID 和路径生成，不随 commit 改变；记录安装时间、更新时间、版本、摘要及定义快照。不会写入 ~/.agents、~/.claude、~/.codex 或修改客户端全局设置。原有全局定义继续由本地目录读取。

所有安装、更新、卸载均有确认界面。安装绑定审核时的 commit 与内容摘要，防止来源在确认前变化。已有文件不覆盖；读写不跟随托管路径符号链接。操作日志先保存意图，文件原子替换后提交登记；中断后按原摘要与目标摘要恢复。遇到额外本地修改保留文件并报告待处理错误，不盲目续写。

更新检查比较真实内容摘要与 commit。只有仓库 commit 变化而定义内容相同时显示内容已最新。审核可比较当前本地文件或上次安装原版与远端版本，显示逐行增删。较大文件采用有界对比，最多展示 6000 行，明确提示查看完整定义。

本地修改默认阻止更新和卸载。用户勾选“先保存独立备份”并确认后，保存原文至 `agents/backups/<安装 ID>/`，再次核对审核时的本地摘要才继续。缺失文件可通过确认更新恢复，或卸载其登记。更新与卸载不会改变已加入团队的成员快照。

“本地 Agent”同时列出客户端全局定义与 UnderControl 托管角色。全局定义可以查看和确认删除，沿用原来的 canonical 路径/digest 保护及恢复日志；托管角色转到“已安装”管理，不通过全局文件删除接口处理。团队成员菜单只“移出当前团队”，保留定义与历史。

## Runtime、Session 与 Teams

Runtime 可用性使用现有 UnderControl runtimes 和 Claude 团队运行时探测。Codex 的 Run.prompt → turn/start、Claude 的 Run.prompt → stdin 已具备文本指令注入路径，不等于原生客户端 Agent 安装。OpenCode 客户端可能可用，但 Marketplace 定义适配未接入，界面分别说明。模型/effort 仍只接受实际返回能力，安装不修改任何全局默认值。

当前没有带角色定义创建独立 Session 的公开接口。因此“创建会话”打开版本化上下文和客户端选择，明确显示缺口并禁用执行；不会创建临时 Schedule 或 Team 冒充独立 Session。上下文包含 installed_id、definition_id、source_id、version、digest、instructions，未来应接既有 Session 服务，不能另建执行系统。

现阶段真实使用方式是在 Teams 的本地 Agent 选择器加入托管角色，使用既有 addMember、消息、Leader 委派与 Run 执行。组合层将安装记录作为 additionalLocalDefinitions 注入现有目录，使用 managed: 前缀，团队保存完整定义及版本快照。后续更新不替换已有成员指令；修改、丢失或操作未完成的托管文件不能作为新成员加入。没有改变执行权限、调度或恢复机制。

## HTTP 契约

前缀 `/api/v1/marketplace`，读接口返回真实结果，写接口要求 JSON。安装/更新/卸载需 `confirm:true`。

| 路径 | 方法 | 行为 |
| --- | --- | --- |
| sources | GET / POST / DELETE | 列出、保存、移除独立 GitHub 来源；写入需明确确认 |
| catalog?source=ID&refresh=1 | GET | 读取或刷新目录，返回版本、解析错误与缓存状态 |
| definition?source=ID&path=PATH&version=SHA | GET | 读取该目录中已发现的固定版本定义 |
| installed | GET | 安装登记、本地摘要、修改/丢失及待处理状态 |
| local?id=ID | GET | 安装快照及当前本地原文 |
| updates?refresh=1 | GET | 检查内容更新、来源移除或不可用状态 |
| review?id=ID | GET | 原版、本地、远端内容及审核时摘要 |
| install | POST | source_id、path、version、digest、confirm |
| update | POST | id、version、digest、expected_local_digest、preserve_modified、confirm |
| uninstall | POST | id、expected_local_digest、preserve_modified、confirm |
| compatibility | GET | 已接入指令传输路径及尚未支持能力 |
| session-context?id=ID | GET | 版本化定义上下文；当前不创建或启动 Session |

Markdown 预览复用 Streamdown 的 sanitize，禁用 raw HTML 解释，不加载外部图片，仅允许 HTTPS 来源链接。脚本、iframe、事件处理器与 javascript 链接不会运行。

## 验证及边界

实际命令和浏览器结果见 [Agent Loop 验证记录](job/agent-loop/03-phases.md)。没有独立 lint 命令；运行源码类型检查、相关 Node/Vitest、生产构建和语法检查。全量类型检查的既有 5 处旧测试错误单独记录，不声称其通过。

没有提交、合并、推送、发布或更新正式安装；正式 43127、sun、用户全局配置与定义未改动。真实安装、修改备份及卸载只在隔离预览数据目录验证。真实独立 Session 创建、OpenCode 定义适配和原生 CLI Agent 格式导出仍未实现。
