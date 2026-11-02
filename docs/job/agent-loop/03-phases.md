# Agent Loop 实施与验证记录

2026-11-01，独立分支`feature/agent-loop`；worktree为项目根目录`.worktree/feature-agent-loop`，基线`91f0870`。用户明确要求停止使用task-doc-workflow并由主Agent自主推进，后续没有阶段确认门槛或自动提交。

## 已交付的首版

- Rooms入口、房间与成员、显式任务、任务消息隔离、阶段成果、执行记录。
- 固定的规划→讨论→收敛→实施→验证→人工验收。验证失败回到实施，预算耗尽等待，不无限循环。
- 共享执行驱动与SQLite连接；既有Scheduled表、约束和接口保持。
- 持久outbox、事务交接、request key去重、输入revision和暂停generation。
- 跨Schedule/协作的目录占用，独立任务worktree，未知执行不自动重放。
- 四个run专用MCP工具及短期凭据；产物真实路径检查；暂停、改目标与重启撤销凭据。
- 暂停/继续/取消、版本化更新目标、人工验收和未知执行对账。

准确的接口及限制见[当前架构](../../agent-loop.md)。原始六阶段计划是长期范围，本次没有将尚未实现的Claude受限实施、动态派单或全部故障窗口标为完成。

## 实际验证

环境：macOS、Node.js 26.3.0、Codex CLI 0.166.0、Claude Code 2.1.309。所有实验使用临时Git项目、独立数据目录、随机loopback端口，未在正式43127执行mutation。

| 检查 | 结果 |
|---|---|
| 60项针对性Node测试 | 通过；涵盖新增store/runtime/recovery/MCP及现有Run、Codex交互、进程supervisor、daemon |
| 3项Rooms UI测试 | 通过；房间/任务消息隔离、Escape关闭弹窗、暂停带当前revision |
| 生产源码TypeScript（不含测试） | 通过，临时tsconfig引用现有配置，仅排除测试；没有改动项目检查配置 |
| `node scripts/check-syntax.mjs` | 175个source文件通过 |
| `npm run build` | 通过；包括独立的run MCP bundle和React产物 |
| MCP握手 | SDK内存连接及实际vendor子进程均能列出四个工具；精确向本run转发Bearer凭据 |
| Scheduled v4增量兼容 | 既有Run逐字段相同，user_version仍为4；共享RunStore关闭后数据库仍可读取；integrity_check=ok，foreign_key_check为空 |
| owner真实崩溃 | 测试中SIGKILL控制进程，真实Node子进程继续存活；重启后为unknown，未再次launch；进程存活时不能对账，确认退出后释放占用 |
| Codex run工具实机 | 首次被默认MCP审批阻止；按官方文档增加仅本run工具的内联审批后，成功提交RILLO_NATIVE_SMOKE_OK |
| Codex完整真实交接 | 两个Codex成员、六次Run全部成功；在托管worktree新增result.txt，实际读取的23字节精确等于`Rillo Agent Loop works\n`；源README及源Git diff未改变 |
| 人工验收 | computer use点击验收完成，页面由待验收变为已完成 |
| 完成后重启 | 同一隔离数据目录重启后仍为completed、六条Run、目录占用为空、ready=true，没有重跑 |
| Claude实机 | 90秒内没有完成模型响应，返回RUNTIME_TIMEOUT；不算成功，不开放Claude实施 |
| 持久Agent配置 | 原生工具探测前后Codex config.toml、Claude settings.json校验值一致；实现只注入单次进程配置 |

针对性Node命令：

```sh
node --test --test-timeout=15000 \
  test/collaboration-store.test.mjs test/collaboration-runtime.test.mjs \
  test/collaboration-recovery.test.mjs test/loop-tool-server.test.mjs \
  test/claude-runtime.test.mjs \
  test/run-service.test.mjs test/run-store.test.mjs \
  test/codex-interactive-session.test.mjs test/process-supervisor.test.mjs \
  test/daemon-runtime.test.mjs
npx vitest run ui/react/features/rooms/rooms-view.test.tsx
npm run build
```

computer use实际检查了房间布局、新任务表单、关闭按钮、房间/任务消息切换、实时阶段推进与验收完成。Escape还通过UI测试验证；本次未使用visual-driven-review，也未验证Linux。

## 旧基线与剩余限制

- 全量`npm run check:types`仍有5个既有测试错误：design-system.test.tsx引用已删除的icon-button/tabs并使用旧Tooltip参数，dashboard-event-source.test.ts保留四参数调用。没有修改这些测试或隐藏检查。
- 既有api-server.test.mjs中两项仍要求Host/Origin返回403，但当前基线已按用户要求删除拦截，实际为200。没有为了让旧断言通过而恢复拦截。
- 本次未声称全套旧测试通过；没有lint脚本，也没有安装额外检查工具。
- Claude受限实施、成功模型交接、统一context/usage指标、动态任务分解、自动验收、历史分页及完整故障矩阵仍未完成。
- task worktree从HEAD创建，不包含源目录未提交的修改。目录协调仅覆盖同一Rillo数据域内管理的执行，不是整机写入隔离。

## 清理与Git状态

验收浏览器页、临时服务和临时测试项目已关闭/清理。8个本次生成的Codex测试会话已归档，没有删除原生历史。

主工作区保持clean；本次源码、构建产物、文档和测试均留在feature-agent-loop worktree。没有提交、推送、合并、发布、升级本机安装版或修改正式定时任务；测试文件也没有被提交。

已扫描190份Markdown维护材料及相关符号引用。README、现行架构与本任务文档已同步；历史spec/job log不改写为当前实现。

## Claude独立对照与完成状态修正

后续在一次性目录中执行不带MCP、禁用全部工具且不持久化会话的最小Claude调用。CLI能初始化，但30秒内没有模型结果，输入tokens为0；测试发出SIGINT后，CLI输出is_error=true、subtype=error_during_execution，并以退出码0结束。没有修改endpoint、model或持久配置，也没有输出认证值。

这证明相同未响应现象在无MCP时也存在；尚不能据此确定具体服务端、网络或模型路由原因。当前Claude实机验收仍未完成。

根据真实输出增加provider结果归一化：CLI表面成功但Claude结构化结果is_error=true时，记录为failed/RUNTIME_PROVIDER_ERROR。已有timed_out/canceled不被覆盖。新增4项测试覆盖只读工具白名单、argv无凭据、禁止Claude写入、session/usage/error解析及退出码0的结构化失败；共60项Node针对性测试、3项Rooms UI测试通过。

## 产品方向纠正（进行中）

用户指出上一版仍是demo：Agent定义过浅、没有@与leader委派、任务表单阻断对话。新的验收目标为“用户在房间消息中说明工作，leader承接，成员互相指派并回报，自动推进到交付”。此前的固定阶段闭环验证不等于此目标已实现。

本轮直接改造：读取实际全局Agent定义及可导入开源目录；房间配置leader与项目；聊天触发内部任务；持久inbox与结构化mention委派/回报；leader按结果决定后续工作和交付；移除新任务dialog。保留已有数据与Scheduled行为。dotfiles仅只读核对，不同步、不修改。沿用当前feature-agent-loop worktree，不提交或发布。

## 消息驱动实现与实际验收

2026-11-01，上文固定阶段原型为历史记录，本节描述后续修订。新聊天不再经过固定流水线，也不需要新任务 dialog。

- 从本机 dotfiles 维护的真实全局定义读取角色，核对 `~/.agents/agents`、Claude 符号链接和实际 Codex TOML 副本。未修改或同步 dotfiles。观察到 Markdown description 的未加引号形式，仅在内存中规范化，原文件不变。
- 接入 Agency Agents，读取固定 commit `b37b5bb33b78f2c1d6567d98e25ca818e3259219` 的定义。实际列表为 214 项，记录 MIT 许可证、来源 URL、revision、digest 及完整角色指令。
- 新增持久 inbox 和成员 ID 路由。用户输入先唤醒 Leader，成员通过 send_message 委派或回报，结果唤醒 Leader。公告不派发，重复请求不重复执行，写入后强制验证，交付不会吞掉期间到达的新消息。
- 更换已交付房间的项目或 Leader 后，下一条消息建立使用新设置的内部任务，先前交付仍保留。
- 移除新任务表单。房间呈现连续消息、Leader、完整成员定义、真实进度和执行交接记录。

实际原生交付使用本地 Backend 角色和开源 Code Reviewer 角色，均由 Codex 运行。用户发一条消息后，依次产生 5 次真实 Run：leading、implementing、leading、verifying、leading，全部 succeeded。Reviewer 的结构化 verdict 为 pass，最后一个事件为 delivery_ready。独立读取任务 worktree 中的 greeting.txt，内容精确为 `Rillo room-driven delivery\n`，共 27 字节；源项目没有 greeting.txt，源 README 不变。没有提交、合并、联网任务或外部服务操作。

### 输入组件修订

用户指出 `@` 和消息输入应复用组件。随后移除手写 textarea、正则匹配、光标恢复及菜单选择状态，改为精简 Kibo EditorProvider、官方 Tiptap Mention/Suggestion 和 shadcn Command/cmdk。Kibo 源码通过官方 registry JSON 审阅后选择性引入，保留 MIT LICENSE；shadcn CLI view 的连接失败，没有声称 CLI add 成功。输入只启用消息所需能力，没有完整文档工具栏或 AI SDK 传输层。

| 依赖 | 处理 |
|---|---|
| React、Tailwind、Base UI、Motion、Lucide | 保留，既有应用仍实际使用 |
| Tiptap 3.32.2 的 react/core/pm/starter-kit/extensions/mention/suggestion | 新增，提供文档状态、原子成员节点、输入法和建议生命周期 |
| cmdk 1.1.1 | 新增，用于候选过滤后的选择与键盘导航。其 Radix 传递依赖来自上游，应用不使用 Command.Dialog，弹窗仍为 Base UI |
| Floating UI DOM 1.8.0 | 复用已有版本，满足 Suggestion peer 并避免双份 DOM 定位依赖 |
| smol-toml 1.9.1 | 新增，读取实际 Codex TOML 定义；server vendor 包含解析器 |
| Kibo 完整工具栏、table、lowlight、tippy.js | 未新增，消息框无需这些模块 |

Chrome computer use 实际核对了本地定义、开源目录和来源预览。输入 `@`，方向键选择 Backend，回车后继续输入，节点保留实际 member ID。发现并修复了异步房间加载后 Tiptap 仍保持初始只读的问题。清空验收草稿后发送按钮恢复禁用。未使用 visual-driven-review。

### 当前验证结果

- 相关 Node 回归 72 项通过，包括消息委派、去重、Leader 等待、迟到输入、交付检查、v1 到 v2 数据迁移、MCP 内存及实际 vendor 子进程握手、崩溃恢复、共享目录占用与 Scheduled 回归。
- Rooms UI 测试 6 项通过，覆盖直接发任务、精确成员 ID、导入完整定义、关闭 dialog/暂停、失败保留草稿和 request key、普通文本不误路由。
- 应用源码 TypeScript 检查通过，179 个源码语法检查通过，生产构建通过，npm 依赖树无 problems，git diff --check 通过。
- 全量 TypeScript 仍有 5 处既有测试问题：design-system 旧 import/Tooltip 属性及 dashboard-event-source 旧参数数量。没有把源码检查通过写成整个仓库测试全绿。仓库没有独立 lint 脚本。
- Claude 真实模型响应验收仍未通过，不开放写入。未验证 Linux。

预览保留在 `http://127.0.0.1:58019/?view=rooms&room=32e539d5-6505-45a0-aedc-6faf7c2c9669`，使用独立临时数据库，保留原预览房间并在迁移前备份。主工作区及正式 43127 服务不变。未提交、推送、合并、发布或更新本机安装版。

## 2026-11-01：原型接入现有 Rooms

依据 `/Users/joi-com/Desktop/opendesign/07b07717-4a23-46e2-bd0d-14a2f8a0f20e/agent-loop-room.html`、brand-spec.md、交付文档和成员定义参考图，在原有 worktree 上实现，没有另建应用，也没有修改原型 index.html。保留消息驱动协作和现有 Tiptap Mention。

### 源码变化

| 文件 | 变化 |
|---|---|
| `ui/react/features/rooms/rooms-view.tsx`、`rooms.css` | 局部深灰三栏、紧凑尺寸、角色身份、用户右侧气泡、对话/看板切换、导航与成员抽屉、Command/Ctrl+K |
| `room-dialogs.tsx`、`room-composer.tsx` | 双来源目录、先落盘再加入、客户端与模型配置、定义快照弹窗、稳定 ID 草稿提及 |
| `room-board.tsx` | Kibo 看板、跨列和列内排序、状态选择、搜索与负责人筛选、行内添加、详情、失败回滚、继续对话草稿 |
| `components/kibo-ui/kanban` | 官方 registry 组件及 MIT 许可，使用 dnd-kit 和 tunnel-rat；不引入新的弹窗框架 |
| `server/src/agent-catalog.mjs` | 市场 Markdown 原子写入实际共享目录，禁止覆盖冲突，保留来源和许可 |
| `collaboration-runtime.mjs`、`collaboration-http.mjs` | 真实客户端/模型验证、成员模型覆盖、按成员读取定义、目录导入与工作项接口 |
| `collaboration/schema.mjs`、`store.mjs`、`board.mjs` | schema 3、成员 execution_config、独立工作项、事务和乐观版本检查 |
| `ui/react/lib/api/dashboard-api.ts`、`loop-types.ts` | 页面与服务字段及返回结构对齐 |
| `package.json`、`package-lock.json` | 新增 dnd-kit core 6.3.1、sortable 10.0.0、utilities 3.2.2、tunnel-rat 0.1.2 |
| `README.md`、`docs/architecture.md`、`docs/agent-loop.md` | 当前界面、导入、模型、工作项语义、HTTP 合同及限制 |

原型 roomId、owner、key 分别映射为 room_id、owner_id 和房间内 number，key 显示为 R-编号。definitionSnapshot 使用成员 profile，模型另存 execution_config.model。没有导入 prototype 浏览器存储、automatic 标志或计时演示。

看板只保存人工工作项，移动卡片不启动或更改 Agent Task/Run。工作项 review 是待验收，与协作 Task review“已交付”独立。返工、归档及卡片移动不相互暗中触发。“在对话中继续”只填草稿，发送由用户确认。

### 实际验证

- Node 回归 80 项通过，包括新增工作项事务、房间隔离、版本冲突、真实文件导入、HTTP 全链路、模型覆盖、定义快照，以及原有协作、Scheduled、执行和恢复测试。
- Rooms UI 测试 10 项通过，包括模型切换重置、市场两步操作、保存失败保留配置、精确 ID 提及和持久化工作项请求。
- 应用源码 TypeScript 检查、180 个源码语法检查、生产构建、依赖树和 lockfile 一致性通过。没有独立 lint 脚本。
- `npm run check:types` 全量检查仍有原先 5 处旧测试错误，位于 design-system.test.tsx 和 dashboard-event-source.test.ts，没有新增 Rooms 类型错误。
- 使用现有 playwright-headless MCP，未安装本地 Playwright，未使用 visual-driven-review。1440px 验证四列、实际鼠标跨列拖动和列内排序，刷新顺序及状态恢复。
- 注入一次看板保存 503，界面显示错误并恢复服务端状态；继续对话填入草稿，发送前消息数仍为 0。
- 实际本地定义加入房间时选择 live 模型目录返回的 ID，任意无效 ID 不能提交。成员定义弹窗显示完整快照和实际成员模型，宽度为 620px，提及节点保留成员 ID。
- 900px 成员抽屉、390px 导航抽屉与单列看板通过，无页面横向溢出。独立触屏 context 通过 tap 打开目录，coarse pointer 下底部按钮为 88×44px，桌面为 88×32px。
- 在验收房间通过真实 Tiptap 菜单提及 Leader 并发送文本任务。任务 `53af090b-70f2-42ea-af6d-a401a174e3b5` 的一次原生 Codex Run succeeded，提交结果“Rooms 接入验收通过”，最终为 review/delivery。没有用演示消息代替执行结果。
- 市场文件落盘的 HTTP 验收使用隔离 home 和真实符号链接目录，验证实际文件内容、扫描刷新、重复提交、当前模型与快照。本次验收没有往用户全局目录添加测试角色；产品操作会写到实际扫描目录。

预览迁移前先停止开发服务并备份。原有 2 个房间、6 位成员、2 个任务、11 次 Run、14 条消息逐行内容均保留。新增的验收房间、成员、卡片和一次真实文本执行独立保存。SQLite integrity_check 为 ok，foreign_key_check 为空，协作 schema 3，Scheduled user_version 仍为 4。

预览：`http://127.0.0.1:58019/?view=rooms&room=fbd78ba3-cdbb-4671-819b-111dee02ce8b`。真实实现和验证均在 feature/agent-loop；主工作区保持 clean。未提交、合并、推送、发布、更新正式安装版或改动正式 43127 服务。未验证 Linux。

### 能力边界

Claude 当前适配没有 live 模型目录，指定模型选项不可用，仅跟随默认模型；讨论与审阅的权限没有扩大。Agent 定义中的 tools/skills 仍只是角色声明。附件上传、自动产物卡、工作项自动驱动执行、跨房间全文检索及 prototype 自动阶段推进均未新增，不展示虚假成功。

本轮最后一次真实市场查询收到 GitHub 未认证 API 的 403 限流。已将该受控错误加入公开服务错误列表，界面显示“目录请求受限，本地定义仍可使用”并提供重试，不把错误显示为没有匹配角色，也不回填示例数据。HTTP 限流回归测试通过。完整市场在线查询需上游限流解除后复验；未为绕过限制读取令牌或更改认证配置。

## 2026-11-02：成员操作、共享上下文与完整房间资料

本轮继续在 feature/agent-loop 推进，没有提交、合并、发布或修改正式安装版。

### 改动

- `room-member-list.tsx`、`rooms-view.tsx`、`rooms.css`：成员主体查看定义，更多菜单提及或更换 Leader；移除每行皇冠。Rooms 弹窗 footer 按钮统一为桌面 88×32px、触屏至少 88×44px。
- `room-dialogs.tsx`、`loop-types.ts`、`dashboard-api.ts`：新建和设置支持多项目及记忆目录；可从原目录恢复到新目录。创建 request_key 在失败重试间保持稳定，避免重复房间与默认 Leader。字段 workspaces、memory_directory、source_directory 直连服务端。
- `collaboration/schema.mjs`、`store.mjs`、`conversation.mjs`、`context.mjs`：schema 4、带来源决定与摘要、完整正文分页、字面关键词查找、成功投递游标，以及同成员/Task/角色模式的原生 Session 续接。网络和限流错误不会触发新 Session 重试。
- `collaboration/room-memory.mjs`、`collaboration-artifacts.mjs`：与业务事务一起保存未导出版本，临时文件 fsync/rename 后确认同步；保存完整房间资料和内容寻址产物。SQLite 文件锁阻止多个服务同时写同一目录。一个房间的写入失败不阻止其他房间，失败在 UI 显示并可重试。
- `collaboration-workspace.mjs`、`execution-resource-coordinator.mjs`、`collaboration-runtime.mjs`、Claude 适配：多项目分别建立 worktree，整组真实目录原子取得，写入 sandbox 仅覆盖这些 worktree；Scheduled 继续使用单项目接口。
- `collaboration-http.mjs`、`mcp/src/loop-server.mjs`、vendor：增加 remember，read_context 支持历史、记忆、结果和归档产物；新增恢复和记忆同步接口。archive/restore 不导出 token hash，不重放旧执行。
- `README.md`、`docs/architecture.md`、`docs/agent-loop.md`：同步当前资料、续接、多项目、失败及恢复边界，并链接固定版本的 Multica 机制依据。

### 实际验证

- 相关后端及 Scheduled 回归共 65 项通过，Rooms UI 14 项通过。包含故障重试、房间隔离、版本迁移、完整资料恢复、产物校验、历史深读、多目录原子占用和创建确认失败后重试不重复。
- 应用源码 TypeScript、182 个源码语法检查、生产构建通过。全量 check:types 仍有原有 5 处旧测试错误（design-system.test.tsx 三处、dashboard-event-source.test.ts 两处）；没有新增 Rooms 类型错误。没有独立 lint 脚本。
- 使用现有 playwright-headless MCP 验证真实鼠标成员菜单、定义查看、桌面 footer。390px 触屏 context 验证抽屉和新建表单，按钮为 88×44px，无页面横向溢出。未安装 Playwright，未使用 visual-driven-review。
- 浏览器创建了包含两个真实 Git 项目和自定义记忆目录的隔离房间 `676ac1ff-f58f-4a0a-866d-d44a42c281b1`。Codex 实际保存一条带来源决定；重启服务后再次发消息，续接同一原生 Session `01a197c9-704a-79b0-847b-241cb33f72d8` 并读回原决定。
- 同一房间实际执行跨项目实施、独立只读核对和交付。7 次原生执行全部 succeeded，最终任务 review/delivery。统筹模式始终使用原 Session；实施和验证各自使用独立 Session。两个 worktree 各新增 rillo-memory-proof.txt，精确为 24 字节 rillo-multi-project-pass，SHA-256 均为 26f221bd1c146a22320ee3a3a5512476cd5650ec505a11fa62d47ac9ecf6f8c9。独立脚本核对文件、源项目不存在目标文件、原项目只有初始 Git 提交。
- 在另一份全新服务索引中，通过浏览器“从目录恢复”实际导入同一房间：2 位成员、10 条消息、7 次执行及产物引用保留，任务先暂停，没有启动任何新执行。临时恢复服务已关闭，原预览继续运行。
- 迁移前备份中的 4 个房间、9 位成员、4 个任务、13 次执行、17 条消息、53 条事件、9 条 inbox 和3个工作项逐项核对；除新增默认 memory_directory 外原字段保留。SQLite integrity_check=ok，foreign_key_check 为空，Scheduled user_version=4 不变。

### 尚未承诺的能力

迁移房间资料不搬迁 Git 仓库、未提交代码或客户端原生 Session 日志。迁移中的旧执行必须先确认，旧任务不直接重放旧路径；新消息在本机项目建立受管 worktree，读取原房间事实继续推进。原生续接失败会保留错误并等待处理，当前没有隐式删除 Session 或自动重建路径。Claude 实际模型侧交付与本轮 Linux 验证尚未完成，未扩大其写权限。

预览：<http://127.0.0.1:58019/?view=rooms&room=676ac1ff-f58f-4a0a-866d-d44a42c281b1>。

## 2026-11-02：收敛创建表单与执行边界

本节取代前一节关于“创建时指定记忆目录和多个项目”的产品交互。此前将资料迁移需求误作创建前提，已纠正：新建只填写房间名称和默认工作目录。资料存储由 Rillo 管理；现有房间设置保留折叠的可选资料存储项，清空可恢复默认位置；恢复房间也可由服务选择目标位置。既有目录、资料和项目记录不删除。

SQLite 是共享消息、任务、决定和摘要的持久来源。资料备份改为后台同步，失败只记录待同步状态并提示，不阻断消息确认、Run 启动或任务交付。显式同步接口仍报告失败，便于用户修复后重试。

额外项目由 Leader 根据用户消息通过 request_action(action=prepare_projects) 准备。服务验证当前角色、用户来源消息、已投递游标和路径，规范化目录并建立独立 worktree。新资源追加到当前 Task，不要求房间提前配置，也不会使下轮聊天丢弃当前任务。成员未结束时不能变更目录；未指明路径时由 Leader 在房间询问。沿用全部目录一次性加锁和实际写入 sandbox 范围。

验证：

- 后端及 Scheduled 回归共 70 项通过，Rooms UI 14 项通过，生产构建、源码类型检查、182 个源码语法检查通过。全量类型检查仍只有原有 5 处旧测试错误。
- 浏览器新建房间只显示两个必填输入：名称、默认工作目录。未填写任何资料路径，服务自动分配默认存储。
- 实际房间 86a981a5-3b57-4355-b028-d83b3e88ebe3 只配置一个项目。用户在对话中给出 backend 路径，原生 Codex 调用 prepare_projects，任务产生 projects_prepared 记录，资源增为两个，房间配置仍只有一个默认项目。一次原生 Run succeeded，任务 review/delivery，没有启动其他成员或修改项目文件。
- 注入资料备份失败后，消息与创建仍成功，原生执行驱动继续交付；默认存储、恢复默认和不指定恢复目标路径均有测试。
- 实跑发现原预览“测试”房间有两条旧队列引用不存在的 worktree 子目录，曾占满并发位。服务现将实际准备失败记为失败并等待处理，没有删除其记录、重建工作区或启动模型。另在准备时检查子目录是否在 Git HEAD 的 worktree 中存在，防止继续创建不可执行任务。

当前预览：<http://127.0.0.1:58019/?view=rooms&room=86a981a5-3b57-4355-b028-d83b3e88ebe3>。未提交、合并、推送、发布或更新正式安装版，未验证 Linux。

## 2026-11-02：仅名称创建与会话指定分支

本节取代上一节“创建房间保留默认工作目录”的交互。新建只填写名称，不要求项目、分支或资料目录。Composer 在未绑定项目时可立即发送；恢复也无需先填项目。创建和恢复使用服务管理的存储，已有绑定及历史任务不删除或重写。

新 Conversation Task 的内部执行目录为数据目录下 rooms/workspaces/<request-hash>。目录由服务创建并校验，不依赖 Git，不退回服务进程当前目录。CLI 始终以该稳定目录续接；准备项目后只增加项目资源及读写范围，不搬迁 CLI cwd。通用任务产物可保存在内部目录；相对产物路径始终以 Task.workspace 为基准，项目产物用 project:1/path 等明确引用。

prepare_projects 增加 execution_mode 和 branch：

- isolated 默认从 HEAD 创建新分支，显式 branch 可指定起点。
- existing_branch 继续本地已有分支，优先复用其已检出目录；否则为同一分支创建 worktree，不另开分支。
- in_place 明确使用原目录，保留已跟踪与未跟踪改动，不切换分支；可用于非 Git 目录。

branch 必须在用户来源消息中出现；未给 mode 而给出 branch 时按 existing_branch 处理。准备时检查真实 Git common directory、当前分支、目录归属，保存 base_commit、dirty 和策略。缺失分支不改用 HEAD，不自动 fetch 或创建远程跟踪分支，不自动 stash/reset。任务已有冲突绑定时明确报错，不覆盖旧策略。

主要修改：room-dialogs.tsx、rooms-view.tsx、rooms.css、dashboard-api.ts、loop-types.ts；collaboration-runtime.mjs、collaboration-workspace.mjs、collaboration-artifacts.mjs、collaboration/store.mjs、conversation.mjs、context.mjs、room-memory.mjs；daemon-runtime.mjs、Run MCP 与 vendor；README 和当前架构文档。

实际验证：

- 后端及 Scheduled 回归 79 项通过，Rooms UI 16 项通过，构建、应用源码类型检查、182 个源码语法检查通过。全量类型检查仍是原有 5 处旧测试错误。
- 浏览器只填名称创建房间 edc56e74-0ef5-4f50-b2eb-c58e5c6a7d09，新建表单只有 title 一个必填输入。未配置项目即可启动原生 Codex，回复“无项目会话已启动”，提交结果并交付，resources 为空。
- 重启预览后，在同一 Task a2846221-3cfe-4ffb-9758-1a2fb5e0c843 发送指定本地 feature/rillo-continue 分支的消息。Codex 实际调用 existing_branch 准备项目并交付。独立 Git 查询确认执行目录检出 feature/rillo-continue，源项目仍为 master；未从 HEAD 另开任务分支。
- 两次原生 Run 均 succeeded，Session ID 都为 01a19809-c47b-7d41-b676-a4a817eaf258，内部 Task.workspace 未改变。
- 真实 Git 测试覆盖已有 checkout 复用、未 checkout 本地分支、起点分支与 HEAD 不同、脏文件及未跟踪文件保留、原目录模式、非 Git 原目录、拒绝自动切换分支、未授权来源和冲突绑定。

边界：existing_branch 目前要求本地分支已经存在，不自动联网获取远端。已绑定任务不静默换分支或策略；可结束当前协作后开始新任务。Claude 实际模型侧交付及 Linux 未在本轮验证。未提交、合并、发布或更新正式安装版。

当前预览：<http://127.0.0.1:58019/?view=rooms&room=edc56e74-0ef5-4f50-b2eb-c58e5c6a7d09>。

## 2026-11-02 — 成员、消息详情、路由和并行

本阶段按主对话八项反馈推进。先核对 Multica 当前 Squads / Mentioning agents 文档：显式 @ 直接路由，无收件人回退 Leader；共享任务事实、成员独立原生会话，不广播唤醒全员。Rillo 改为明确收件人直接派发；成员结果自动回到委派者并通知 Leader，reply 无 mentions 时取实际委派来源，普通回复不建立无限回调。send_message 可声明同 Task 前置 Run 依赖；就绪独立任务不被前面的阻塞指派挡住。Leader 可取消失败依赖的待执行指派。

同目录只读工作使用共享读锁，写入与 Scheduled 仍使用排他写锁，未知占用不共享。默认并发 2，同一成员同一 Task 仍不并发使用同一个原生会话。写入范围保持保守互斥，不宣称多个成员可同时修改同一目录。

界面复用 MessageResponse / Streamdown，以及适配 Base UI 的 AI Elements Reasoning、Tool、Attachments、ModelSelector 组合。Codex Turn 使用局部 concise 公开摘要，捕获真正返回的摘要、MCP/命令输入输出；不显示 raw reasoning，不改变全局配置。运行内容节流持久化、有界保存并脱敏凭据键。刷新可恢复。原来的底部微小工作文字改为各成员的实际消息运行卡片。

成员支持房间别名、离线 DiceBear Micah 搭配头像、模型和真实支持的 effort；模型变化重置 effort。别名、头像编辑保留既有模型配置，不要求离线客户端重新验证未改变的模型。头像不请求外部网络，保留 Micah Lanier / CC BY 4.0 署名。

房间支持解散，先停止本房间运行、撤销凭据，保留历史。成员真删除按用户明确选择，同时删除本地全局定义，其他房间保留已有快照。删除先显示 canonical 文件和 digest，内容变化拒绝；临时重命名与 SQLite 操作日志处理失败回滚和崩溃恢复，阻塞清理可在房间重试，不阻断其他房间。历史成员快照随 loop_schema=5 迁移，Run 和消息不依赖已删除的成员行。

输入框可引用服务器图片/PDF 路径，无浏览器上传。重新检查实际签名、大小、digest；图片走 native localImage。PDF 使用隔离 Worker + unpdf/PDF.js 提取有界文本，可分页读取完整已提取内容。文件预览限定到已保存消息引用，不能通过 GET 拼任意路径。图片原文件及 PDF 原文件须单独保留/迁移。

主要文件：

- ui/react/features/rooms/{rooms-view,room-messages,room-member-list,member-identity,member-runtime-fields,room-dialogs,room-composer,room-board} 及 rooms.css。
- ui/react/components/ai-elements/{reasoning,tool,model-selector,attachments} 与 loop-types/dashboard-api。
- collaboration-runtime/http、agent-catalog、execution-resource-coordinator；collaboration/{schema,store,conversation,context,run-parts,attachments,pdf-text-worker,member-configuration,room-memory,board}。
- Codex/Claude 事件适配、Run-scoped MCP、server vendor 构建、package.json / package-lock.json 及依赖许可记录。
- README、architecture、agent-loop 活跃文档。

实际验证：

- 108 项后端/Run/协作回归通过；19 项 Rooms UI 测试通过；应用源码严格类型检查、生产构建、187 个源文件语法检查通过。全量 check:types 仍有原来的 5 处旧测试错误：design-system.test.tsx 三处（两个已不存在的旧导入、Tooltip delay），dashboard-event-source.test.ts 两处（旧四参调用）。没有独立 lint 脚本。
- 真实 Codex 并行验收房间 8510b148-c1eb-48ad-b8ff-722e0a60f1bd：两成员 Run 分别在 17:59:34.207Z、17:59:34.210Z 领取；独立 PID、独立 Session，两者实际时间重叠。两成员读取同一用户消息并提交，均 succeeded；Leader 在两者完成后领取汇总并交付，Task 为 review。Session：01a19844-4a4f-7263-990f-e86705984fa3、01a19844-4a4f-7730-86ea-fb0add20a942。
- 真实附件验收房间 078e4322-7a8d-46fa-9fb4-09597b65595c：新建左右红蓝 PNG 与含 RILLO-PDF-ORCHID-2468 的 PDF 测试文件。Codex 原生视觉正确报告左红右蓝，并准确提交 PDF 口令；成员和 Leader 两 Run 均 succeeded、交付 review。公开摘要 “Preparing final delivery” 和真实 submit_result 输入输出在浏览器可展开；无伪造思考。成员 Session：01a1984c-e184-7422-99c3-0f95b6e0474a。
- Playwright headless 实际浏览器验证别名、头像搭配、真实模型/effort 保存后刷新恢复；文件错误保留输入；删除测试成员和解散测试房间；真实摘要/工具展开及引用文件预览。修复 MessageResponse 的 100% 高度导致附件覆盖后续消息，实际几何确认附件完全包含在消息内、后续消息无重叠。
- 1440px 桌面、900px 成员抽屉、390px 导航/成员抽屉和弹窗均无横向溢出。触屏 context 的 footer 两按钮均为 88×44；桌面仍为 88×32。
- 删除在隔离 HOME 验证实际文件删除、失败恢复、digest 变化拒绝、崩溃恢复、清理阻塞重试、其他房间快照保留、物理移除成员、历史资料备份/迁移和 foreign_key_check。没有删除真实用户全局 Agent 文件。
- 预览迁移前 SQLite backup 已保存；升级后所有既有表记录数未改变，foreign_key_check 无结果、integrity_check=ok。Scheduled PRAGMA user_version 仍为 4。/health/ready 正常。

边界：Claude 的结构化事件解析已有自动化检查，但仍缺少真实 Claude 模型侧多媒体/讨论验收。PDF 扫描件不提供 OCR，字体限制可能影响提取。Linux 未验证，正式 43127 和 sun 未修改。新增 AI Elements 参考许可为 Apache-2.0（非 MIT），unpdf 为 MIT、PDF.js 为 Apache-2.0；许可与署名已保留，未来发布前须核对与仓库 GPL-2.0-only 的组合分发要求。本阶段未提交、合并、发布或更新正式安装。

预览：<http://127.0.0.1:58019/?view=rooms&room=078e4322-7a8d-46fa-9fb4-09597b65595c>。


## 2026-11-02 — Teams 命名、会话组件及 Sessions 关联

本节记录后续实现，前文 Rooms 名称、旧路径和预览链接保留为当时的实施事实。当前前端入口为 ui/react/features/teams/teams-view.tsx，产品导航为 Sessions、Schedule、Teams，页面使用 view=teams、team、team_view。旧链接读取后规范化；旧 API、数据库表及资料格式继续兼容既有数据，不通过界面更名迁移用户资料。

对话实际组合 AI Elements Conversation、Message、PromptInput、ChainOfThought、Reasoning、Tool、Task、InlineCitation。输入仍为 Tiptap 稳定成员 ID Mention，不另加聊天传输；执行内容按实际收到顺序显示，思考只取公开摘要，工具展示真实输入输出。已有 Session ID 或执行内容时不再显示“正在连接”。Agent 组件用于成员定义与目录配置预览，不接管 Agent 执行。共享身份展示移至 components/agents，Teams 和 Sessions 使用相同头像、别名与 Leader 标识。

左侧团队菜单提供解散与删除，执行前显示实际影响。解散停止本团队未完成执行，保留已交付 review 状态。删除在解散后隐藏 Teams 列表项，保留原生会话、数据库历史及备份，不删除全局 Agent 文件。对未知执行仍要求对账，不假定进程已结束。

Sessions 经 daemon 注入 projectSessions 批量补充团队元信息。新 Run 保存 provider/store/session；旧记录须匹配原生 ID、provider 与 workspace。不会将其他 provider/store 的同名 ID 关联到团队。已移除成员读取历史快照；原生子会话继承所属团队但保留原生父子/fork 关系。列表按团队名分组并显示成员身份，标题始终使用用户任务名，自动 Leader 后续指令不能覆盖标题。已确认团队会话中的内部启动说明折叠为可展开的“团队执行上下文”，原文保留。

主要文件：

- ui/react/features/teams/{teams-view,team-sidebar,team-run-task,room-messages,room-composer,room-dialogs}、teams.css。
- ui/react/components/ai-elements/{agent,prompt-input,chain-of-thought,task,inline-citation}，components/agents 及 Sessions 列表与阅读面板。
- server/src/collaboration/session-projection.mjs、collaboration-runtime/http、collaboration/store/schema、session-browser 与 daemon-runtime。
- README、architecture、agent-loop、组件来源登记和 UI/server vendor 许可说明。

实际验证：

- 后端/Run/协作相关 120 项通过；Teams、Sessions 团队关联与应用 shell 共 28 项 UI 测试通过。应用源码严格类型检查、生产构建、188 个源码语法检查和 git diff --check 通过。
- 全量 check:types 仍为原有 5 处旧测试错误。旧 Sessions 测试有 16 项失败；以 HEAD 原始源码和测试重新执行得到相同失败名称，新增失败为空，不将其报告为全套通过。仓库没有独立 lint 脚本。
- Playwright headless 创建团队 d5b367b8-5525-4270-bb35-efe7ef66b6c3，真实 Codex 会话 01a19a17-0523-7942-8eff-c08f2f93d4ef 成功提交并交付。浏览器实际检查来源悬停、运行链与工具详情、向上阅读和回到最新消息、Sessions 团队分组及内部上下文折叠。
- 从左侧菜单解散该验收团队，已交付 Task 保持 review，消息数 2→2；随后删除，团队从侧栏消失，Sessions 仍保留原生会话、团队分组及“已删除”标识。未删除用户团队或真实全局定义。
- 最终重启前确认无 queued/starting/running/stopping/unknown Run；重启后 15 张 loop_/scheduled_ 业务表记录数均未改变，integrity_check=ok，foreign_key_check 无结果，/health/ready 正常。
- 文档盘点覆盖仓库 204 份 Markdown（其中 docs 190 份）。活跃文档统一 Teams 与 team_view，旧 Rooms 路径仅保留于明确标注的历史记录和兼容说明。补齐 API 生命周期说明、schema=5、组件来源与许可记录；当前实现以 docs/agent-loop.md 为准。

边界：没有新增依赖或替换执行传输；本轮没有真实 Claude 模型侧、Linux 验收，也没有提交、合并、发布或更新正式安装。正式 43127、sun、真实定时任务及用户全局配置未修改。此前许可组合分发核对事项仍保留，不因组件登记完成而视为已解决。

当前预览：<http://127.0.0.1:58019/?view=teams&team=078e4322-7a8d-46fa-9fb4-09597b65595c>。


### 2026-11-02：移除重复看板入口

移除左侧“协作任务”入口及仅供它使用的图标、样式，保留顶部“对话 / 看板”。顶部看板继续按当前选中团队 ID 查询与保存，不汇总其他团队，不修改协作执行。Teams UI 22 项、应用源码严格类型检查、生产构建和 git diff --check 通过。预览在确认没有未结束 Run 后重载；Playwright 实际确认侧栏不再出现重复入口，顶部可切换当前团队四列看板及返回对话。活跃功能说明已同步；未提交或发布。


### 2026-11-02：消息行内提及与收件人展示

去掉正文上方重复的蓝色 @ 行。消息阅读基于已持久化 mentions ID，在 Markdown 普通文本中显示可点击的行内成员，复用现有 Agent 定义弹窗。代码、链接、邮件地址及未登记的 @ 文本不转换。未出现在正文、已经改名或同名不能确定的成员以小号次要色“发送给”显示，已移除成员保留静态标签。不改动原始消息、投递 ID 或后端路由，也不新增依赖。

使用 Streamdown 的正式 remarkPlugins 扩展点，保留默认插件；收件人作为插件显式参数传入，避免处理器缓存把其他消息的成员带入当前消息。静态消息在身份变化时更新，不改动原有 Run 内容流式渲染。

修改 message-mentions.tsx、room-messages.tsx、teams-view.tsx、teams.css、对应 UI 测试及当前功能说明。7 项针对代码/链接、同名、已移除成员、重命名和键盘操作的测试，加上 23 项 Teams UI 测试共 30 项通过。应用源码严格类型检查、生产构建、git diff --check 通过；全量 check:types 仍只有已记录的 5 处旧测试错误。仅前端改动，未重复运行无关执行或 Linux/Claude 原生测试。

Playwright 实际查看原截图“测试 03”（06dd73fa-44a5-4b1c-a89a-035167fc3a61）：用户正文显示 Frontend Developer、backend-architect 两个行内提及，无旧收件人行；Leader 委派在正文无提及时显示 11px 次要色“发送给”。点击前端成员打开正确的 Agent 定义及完整指令，保持原始成员 ID。另检查旧测试成员缺少定义时显示明确提示，不替换为其他角色。行内字号和行高与正文一致，页面无横向溢出。预览重载前确认没有未结束 Run，未修改消息或启动模型。未提交、合并或发布。


### 2026-11-02：执行过程内容越过右边框

实际“测试 05”团队 43444779-ee10-4450-af5b-877d4a0ba98d 的首条成员执行含长命令和 ASCII 代码块。在 1280px 视口中，执行过程外框宽约 707px，内容却以最小内容宽度撑到约 776px；更窄视口越界更大。原因是 room-run-activity 的 Grid 列使用默认 auto 最小宽度。仅将该列改为 minmax(0,1fr)，保留代码自身滚动和原有工具标题省略，不给页面加整体裁切，也不改变运行内容及状态。

应用源码严格类型检查、生产构建和 git diff --check 通过。此次为单条 CSS 约束修改，未新增镜像实现的测试，也未重复无关运行时测试。Playwright 在刷新后的实际预览展开全部三条执行过程，1440、1280、1100、900、390px 中均无卡片子项越过外框，工具及展开图标均在按钮内部，页面无横向溢出。预览在确认无未结束 Run 后更新，/health/ready 正常。检查直接相关功能说明，用户契约不变，无需改动活跃接口文档。未提交、合并或发布。


### 2026-11-02：直接展示公开思考摘要

执行过程中的公开摘要改为 MessageResponse 直接显示，保留实际收到的顺序和原文，字号 12px、次要色；移除重复的脑图标、摘要标题、边框和单独折叠按钮。执行过程自身的展开/折叠和工具详情保持原状。不再使用的 Reasoning 组件、专用样式及导入一并移除，更新活跃架构、功能与组件来源记录；历史日志保留原实现说明。

23 项 Teams UI 测试通过，既有公开摘要验收改为展开执行过程后即可阅读，无须再次点击；源码类型检查、生产构建和 git diff --check 通过。Playwright 在实际“测试 05”会话中确认 Designing simple ASCII wireframe 直接显示为 12px 次要色，摘要无边框、按钮或图标，旧卡片数量为 0。预览更新前确认无未结束 Run；未启动新模型执行、未提交或发布。


### 2026-11-02：显示真实委派动作与独立产物执行规则

检查“测试 07”（0c71ff9c-dd90-4a01-b34f-d64be3a29154）确认：后端并非按角色自动接单，Leader 真实调用 send_message(intent=delegate,mentions=[后端 ID])，持久化 delegation 记录随后创建后端 Run；后端 reply 再唤醒 Leader。原界面统一“发送给”未明确区分委派和普通回复。

团队快照根据最近消息所属 Task 的持久化 agent_message 事件批量补充 messages[].intent，核对消息和来源 Run。标题及收件人行区分指派、验证、回复、广播；收件人仍使用稳定成员 ID 和现有定义弹窗。旧记录缺失凭据不猜测动作，正文已含提及不重复收件人。复用现有事件与索引，不改 schema、派发、权限或原消息。备份中的事件仍可恢复动作；单条广播不会因此启动成员。

同时修正 executionPrompt 的过度路径限制：独立新应用可在服务管理的任务目录创建源码，无须先指定仓库或初始化 Git；只有修改现有项目而目标不明时才询问路径。明确应按实际依赖安排有用的并行工作，保留目录锁和写入后只读验证要求，不把所有成员自动唤醒，也不规定固定阶段。已有项目授权、分支和 worktree 策略不变。

主要文件：collaboration/store.mjs、context.mjs；loop-types.ts、room-messages.tsx、message-mentions.tsx、teams.css；对应协作与 UI 测试；README、architecture、agent-loop 活跃文档。

实际验证：

- node --test test/room-conversation.test.mjs test/collaboration-runtime.test.mjs test/room-memory.test.mjs：42 项通过。
- node --test test/room-teammates.test.mjs test/collaboration-store.test.mjs test/room-catalog-http.test.mjs：26 项通过。
- npx vitest run ui/react/features/teams/message-mentions.test.tsx ui/react/features/teams/teams-view.test.tsx：32 项通过。
- 应用源码严格类型检查、生产构建、188 个源码语法检查及 git diff --check 通过。全量 check:types 仍为已记录的原有 5 处旧测试错误，没有新增类型错误。
- 隔离的无 Git、无项目绑定执行测试实际写入 index.html，经过另一成员只读读取与 pass 后交付 review；只有一个执行获得 workspace-write，全部执行的目录范围仍限于同一托管目录。该验证使用执行器桩，不是新的真实 Codex 模型任务。
- Playwright 查看原团队，实际显示 Leader 的“指派 / 指派给 @backend-architect”，后端的“回复 / 回复给 @Leader”，以及 Leader 广播。接口动作与持久化事件一致，用户消息不被误标为委派。原历史任务仍为 waiting，没有修改其消息、重放执行或代用户续跑。
- 盘点 204 份 Markdown，更新相关活跃说明，README/架构/功能文档的本地链接无断链。历史记录保留当时行为。预览在确认无未结束 Run 后加载最新代码，/health/ready 正常。

边界：真实模型是否在每次任务中选择合理并行仍需后续任务验收，本次没有把提示词修改声称为真实模型交付证据。未提交、合并、发布或更新正式安装，未操作正式 43127、sun 或全局 Agent 定义。


### 2026-11-02：从成员配置复制房间

用户指定操作名称为“复制房间”。左侧团队条目的菜单新增该入口，打开名称弹窗，默认“原名称 副本”。确认后创建并进入新团队的对话视图。复用当前成员的别名、头像、运行客户端、模型/effort、完整指令及 profile 来源快照，为团队和全部成员生成新 ID，并映射原 Leader；原团队继续保留原状。

新增 POST /api/v1/teams/:id/copy（title、request_key）。团队与成员在 SQLite 同一事务中创建，任一成员写入失败全部回滚。同来源与名称的并发重试返回同一团队，变更参数使用旧 key 返回冲突。复制离线成员不需要重新探测 CLI 或读取/导入全局定义。新团队分配独立默认资料目录，不带入源团队指令、项目绑定、消息、任务、原生会话、执行状态或看板，不启动模型。已解散团队可作为成员来源；已删除来源或缺少有效 Leader 时明确失败。

修改 team-sidebar.tsx、room-dialogs.tsx、teams-view.tsx、dashboard-api.ts；collaboration-runtime/http、collaboration/store；复制相关后端与 UI 测试，以及 README、architecture、agent-loop。

实际验证：

- node --test test/team-copy.test.mjs test/collaboration-store.test.mjs test/room-memory.test.mjs：29 项通过。覆盖配置和定义快照精确保留、Leader 非首位、独立身份与目录、无历史、编辑互不影响、五个并发重试、防参数冲突、成员插入失败回滚、已解散来源、非法输入及外键检查。
- npx vitest run ui/react/features/teams/teams-view.test.tsx：26 项通过。覆盖菜单入口、默认名称、创建后切换对话、失败保留名称及相同请求 key 重试。应用源码严格类型检查、生产构建、188 个源码语法检查、git diff --check 通过；全量 check:types 仍只有原有 5 处旧测试错误。
- Playwright 从“测试 07”（0c71ff9c-dd90-4a01-b34f-d64be3a29154）复制为“复制房间 · 界面验收”（23fb5d74-579e-402a-9348-ab8fa766ffb3）：3 位成员配置逐项相同，成员 ID 全新，Leader 对应关系正确，消息与任务均为 0，自动进入 conversation。源团队快照前后完全相同。弹窗两个按钮均为 88×32。
- 验收副本随后通过其自身菜单删除并从列表移除，遵循现有保留历史的删除语义；原团队仍可查看，未操作其成员或任务。没有启动真实模型任务、写入全局定义或复制私人原生上下文。
- 扫描 204 份 Markdown 并同步相关活跃说明与 API 契约，本地链接无断链；预览 /health/ready 正常。未提交、合并、发布或更新正式安装。


### 2026-11-02：ECC 动态 Agent 市场

确认 ECC 当前官方来源为 affaan-m/ECC（MIT），以 agents 根目录下的角色 Markdown 接入，保留 Agency Agents。市场按服务端注册信息提供，前端从 GET /api/v1/agent-catalog/sources 获取选择项，不硬编码市场名单。目录在线读取 main 当前 commit 与 Git tree，各来源缓存 10 分钟；并发请求合并，refresh=1 可立即刷新。列表的角色来自实际目录，不维护固定角色数组。源码、定义读取和导入使用具体 commit；已导入文件及团队成员快照不随目录刷新改变。

添加 Agent 弹窗增加市场来源选择与刷新按钮。刷新保留当前角色的路径选择及用户填写的名字，失败保留此前目录/配置并展示错误。ECC 导入为 ecc-<slug>.md，避免覆盖同名用户定义；重复同版本导入不重复写入，不同内容或版本返回冲突。角色 tools/skills 仍为声明信息，不安装 ECC 插件、hooks、规则或 skills，不扩大执行权限或变更全局默认模型。

主要文件：agent-catalog.mjs、collaboration-runtime/http；loop-types/dashboard-api；room-dialogs.tsx、teams.css；Agent catalog/HTTP/Teams UI 测试，以及 README、architecture、agent-loop。

实际验证：

- node --test test/agent-catalog.test.mjs test/room-catalog-http.test.mjs：12 项通过，包含旧 Agency 导入兼容、新 ECC 目录过滤、TTL 与强制刷新、独立缓存、并发请求合并、固定版本读取、刷新失败可重试、文件名隔离与不覆盖、服务端动态来源及未知来源拒绝。
- npx vitest run ui/react/features/teams/teams-view.test.tsx：28 项通过，包含服务注册的新来源无须前端硬编码、刷新后的固定定义、保留成员名和错误时保留配置。应用源码严格类型检查、生产构建、188 个源码语法检查及 git diff --check 通过。全量 check:types 仍只有已记录的原有 5 处旧测试错误。
- 直接读取 ECC 官方 API，版本 b38be6a7f6350964d59328b52f0624e1d1d552d1，发现 71 个角色。读取 agents/planner.md 完整指令 7747 字符，并在隔离临时 HOME 完成真实文件导入，返回 local:ecc-planner、MIT 及正确 commit，Codex 模型为 null，重复导入 imported=false；临时目录已清理，真实全局定义未改动。
- Playwright 从实际预览的“添加 Agent / Agent 市场”加载 ECC 71 个角色，搜索并选择 planner，强制刷新返回 200，保留“我的规划师”草稿，来源 URL 固定到该 commit。来源选择切换 Agency Agents 返回 200、214 个角色。未点击正式导入或加入团队，没有写入真实全局文件或启动模型。弹窗按钮仍为 88×32，无横向溢出。
- 扫描 204 份 Markdown，同步相关活跃来源和 HTTP 契约，本地文档链接无断链。预览重载前确认无未结束 Run。没有提交、合并、发布或更新正式安装；未变更 Scheduled、sun 或正式 43127。
