# Agent Loop 实施计划

状态：本文件保留原始计划。用户后续否定固定阶段原型，新实现改为消息驱动的 Leader 协作，实际合同以 docs/agent-loop.md 为准。原始六阶段计划未全部完成。用户已明确要求不使用task-doc-workflow，由主Agent自主推进。依据：[范围确认](00-discussion.md)及[Rillo增量架构](../../agent-loop.md)。

目标：在Rillo独立worktree中实现房间发起任务、有限讨论、指定成员实施、验证和交付，支持可解释的干预与重启恢复。首版保持单daemon，不迁移历史scheduled_runs，不重新启用旧Tasks。

当前实现入口已迁至 `ui/react/features/teams/teams-view.tsx`；以下旧路径和阶段安排仅记录原计划。当前契约见 [Teams 架构与接口](../../agent-loop.md)，最新验证见 [实施记录](03-phases.md)。

## 全局约束

- worktree固定为项目根目录`.worktree/feature-agent-loop`，分支`feature/agent-loop`；每次写入或测试前确认工作区根目录。
- 实现、实验与验证使用独立数据目录和端口；不访问正式43127进行mutation，不读取真实任务目录作为执行输入，不改持久Agent配置。
- 保持现有React、TypeScript、Node.js 24+、SQLite和UI组件体系，不增加第二个控制服务、执行daemon、消息broker或向量数据库。
- 原生会话由CLI维护；房间消息、任务决定和成果属于应用数据。旧tasks.sqlite及spool不迁移、不读取。
- 首版新增协作表和共享租约表；既有scheduled_runs、Schedule定义和公开Run ID保持不变。数据库唯一关闭权在daemon组装层，store不能关闭其他领域正在使用的连接。
- 协作模块不包装RunService；从现有执行路径提取共同驱动，由公共祖先模块提供。禁止新增跨兄弟feature内部实现导入。
- 模型输出只能请求动作，不能自行改变目标授权、参与者或目录范围。结果必须绑定输入和计划版本。
- 未确认旧进程退出时不释放写入资源、不另起替代写入者；未知投递不得通过换ID或换transport自动重发。
- 当前已有旧测试失效是基线事实；先记录具体文件与错误，不把新失败归为基线，不修改CI来隐藏问题，不声称当前全套测试通过。
- 不自动提交、推送、合并、发布或升级本机安装版。测试文件未经用户明确允许不纳入提交。

## 本轮已完成的规划产物

- worktree与源码基线核对。
- Spark、需求、ADR、固定版本Multica材料与Rillo实际代码对照。
- 增量架构：数据归属、单daemon、执行驱动、状态、持久唤醒、资源互斥与UI边界。
- 下列文件级实施顺序及可观察的验收条件；按此顺序增量实现并验证，不再设置workflow确认门槛。

## 阶段1：能力实验与执行契约

目标：证明CLI可以支持协作需要的操作，再冻结执行规格及权限边界。

涉及现有文件：
- `server/src/runtime/runtime-agent-registry.mjs`
- `server/src/runtime/adapters/codex.mjs`
- `server/src/runtime/adapters/codex-interactive-session.mjs`
- `server/src/runtime/session-messaging/providers/claude.mjs`
- `server/src/runtime/process-supervisor.mjs`

拟新增公共契约模块：`server/src/agent-execution-contract.mjs`。其字段不从Schedule对象推断，明确ExecutionRef、runtime、workspace、输入、权限、超时、恢复目标及结果。

实验：在一次性目录中分别验证Codex和Claude的启动、事件、最终结果、用量、session ID、停止和续接。尝试受限写入及副作用工具，记录版本和实际限制；不得使用用户工作目录验证“只读”。同名字段不代表不同provider语义相同。

验收：每项能力有真实通过、失败或不可用证据；mock与实机分开记录。Claude不可用时记录证据，保留适配与能力边界，继续Codex闭环；不自行安装、改鉴权或声称Claude已验收。恢复失效与网络/限流的处理可区分。

## 阶段2：提取执行驱动与共同资源协调

依赖：阶段1执行契约。

涉及现有文件：
- `server/src/runs/run-service.mjs`：保留Schedule归属、Run持久化与旧API行为，抽出原生进程执行部分。
- `server/src/runs/run-store.mjs`：核对恢复、连接归属与现有唯一约束，不重写历史数据。
- `server/src/daemon-runtime.mjs`：创建共享依赖并注入两个业务来源。
- `server/src/scheduler/scheduled-run-logs.mjs`：让公共日志句柄支持明确执行来源，旧Schedule日志路径不变。

拟新增：`server/src/agent-execution.mjs`、`server/src/execution-database.mjs`、`server/src/execution-resource-coordinator.mjs`。

数据库方案：复用配置中的scheduler.sqlite，在独立协作版本记录下添加新表，不借此修改RUN_SCHEMA_VERSION或删除旧表。连接由daemon组装层创建并负责关闭；同步事务中不执行await。原有schema初始化、备份和降级行为必须先用临时v4库验证，异常时不启用协作模块。

资源协调方案：记录真实目录与ExecutionRef，所有Rillo来源的副作用执行共用互斥。等待资源的Run不启动CLI；重启对账不按租约超时推断进程死亡。不会管理系统中其他工具手工启动的进程。

验收：现有Scheduled执行、停止、超时、恢复、日志和原生会话读取的针对性回归行为保持；不同来源竞争同一目录时最多一个写入者；失联占用进入unknown。没有第二套原生进程启动路径。

## 阶段3：协作持久数据、状态和唤醒

依赖：共享数据库和执行契约。

拟新增：`server/src/collaboration/schema.mjs`、`store.mjs`、`transitions.mjs`、`loop.mjs`、`context.mjs`。同目录模块可以依赖自身领域内部文件，共享执行模块从公共祖先导入。

实现：Room、AgentProfile、Message、Task、PlanStep、CollaborationRun、Result/Artifact引用、Event、Wait及Outbox；先支持固定阶段及有限动作，不做通用Workflow编辑器。

事务职责：创建任务与首个待执行动作同事务；接受结果、写系统结果消息和满足等待同事务；每个Run只有一个最终结果键，同一步attempt和同一等待代次去重。旧需求版本或暂停代次不能推进当前计划。

验收：同房间两个Task不串消息；重复请求不重复派发；多结果同时完成只唤醒协调者一次；结果先到再注册等待不会沉睡；暂停/取消阻止未执行动作；事件重放后状态保持一致。

## 阶段4：受控Agent工具与闭环执行

依赖：阶段1能力证据、阶段2驱动、阶段3状态事务。

涉及现有文件：`server/src/api-server.mjs`、`server/src/daemon-runtime.mjs`、runtime registry和adapter。拟新增`server/src/runtime/adapters/claude.mjs`，具体SDK/CLI选择由阶段1证明；不得直接把消息provider注册成任务执行器。

拟新增：公共组装模块`server/src/collaboration-runtime.mjs`、协作权限模块与`mcp/src/loop-server.mjs`。注册用户操作面和run专用read_context/request_action/submit_result/report_progress。现有session_*、schedule_*工具合同保持，run工具只在受控执行中注入。

权限：短期凭据绑定任务、角色、输入版本和允许动作；不信任请求自报身份。注入方式须由provider能力实验确认，不修改全局配置，不把凭据放argv或日志。

闭环：创建协调Run→有界讨论→一次收敛→资源条件满足后实施→对指定成果验证→交付review或按已授权策略完成。授权内自动交接；正文mention不直接触发新执行。

验收：错误身份/过期版本/超出权限动作被拒绝；结果无效或旧进程未退出时不推进；执行已接受但状态未知时不自动换通道；CLI退出与成果验收分别显示。

## 阶段5：Rooms与现有Sessions衔接

依赖：阶段4操作面和事件契约。保持现有UI体系，不新增竞争组件库。

涉及现有文件：
- `ui/react/app/navigation.tsx`、`dashboard-app.tsx`
- `ui/react/lib/preferences/dashboard-preferences.ts`
- `ui/react/lib/api/types.ts`、`dashboard-api.ts`
- `ui/react/lib/query/keys.ts`

拟新增：`ui/react/features/rooms/`。房间列表、消息/任务目标、参与者、运行状态、等待原因和成果按一套视图组织。新建任务明确资源和投递目标，普通消息与执行请求分开。暂停、停止和unknown使用真实状态，不使用Agent自述替代证据。

原生会话入口通过应用层导航至Sessions，并携带准确SessionRef；不直接导入Sessions内部组件。不修改Sessions的Workspace/Branch分组、全局正文搜索和Pin语义；Scheduled表单、时段与运行记录保持。

验收：Rooms路由可刷新和恢复选择；同一房间任务归属清晰；断线重取快照后无消息丢失/重复；键盘和关闭页面行为正常。使用computer use检查实际页面，不把静态截图等同于闭环验收。

## 阶段6：故障恢复、回归和交付

依赖：全部闭环行为。

故障注入点：派发事务后/CLI启动前、启动后/记录PID前、结果写入后/确认前、等待注册前后、停止请求后未确认、服务重启时仍有原进程，以及旧需求结果晚到。

覆盖范围：执行唯一性、目录互斥、幂等、unknown处置、持久等待、会话恢复/重建、用户改目标、有限预算、无进展暂停。验证计划完成需要成果证据，进程退出不直接标记业务完成。

已有回归：Scheduled cadence/work_hours、继承/auto/compact、消息投递与未知回执、Sessions查询/搜索/原生关系、MCP握手、版本/安装包。CI旧基线问题单独列明，新增回归使用可复现夹具验证。

交付：更新README和架构，记录provider版本/能力、数据备份与恢复步骤、实际检查结果和剩余限制。未经单独授权，不提交测试文件、不合并主分支、不发布、不改变正式服务。

## 需求覆盖与证明

| Spark需求 | 对应阶段 | 必须看见的结果 |
|---|---|---|
| R01 本机持久工作空间 | 3、5、6 | 关闭网页后任务继续，重开可读取，服务重启按状态恢复 |
| R02 房间与具体任务 | 3、5 | 同房间两个任务消息与Run完全隔离 |
| R03 讨论后指定成员实施 | 3、4、5 | 意见和方案齐备、前一写入者退出后才实施 |
| R04 人的干预 | 3、4、5、6 | 暂停不再派发，停止未确认不显示已退出，继续不重做已接受步骤 |
| R05 中断与重复恢复 | 1、2、3、6 | 不重复启动，不因失联释放写入占用；恢复失败明确重建 |
| R06 输出与验收 | 3、4、5、6 | 成果绑定版本，缺少结果或验收证据不能完成 |
| R07 写入范围与并发 | 1、2、4、6 | 同目录最多一个副作用执行，权限声明有实测依据 |
| R08 循环与等待 | 3、4、6 | 每次唤醒可追溯，预算和无进展触发明确等待/暂停 |

## 推进授权

2026-11-01用户明确要求：“不使用 task-doc-workflow，你自己去主导推进”。停止使用该workflow及其确认门槛，直接实现并验证；保留这些文档作为设计和进度记录。不自动提交、发布或修改正式服务。

## 实施差异（2026-11-01）

用户明确要求自主推进后，采用最小可验证闭环。共同驱动已抽取，Scheduled历史未迁移，共享数据库关闭权与跨来源目录占用已实现。任务状态/阶段推进合并在collaboration/store.mjs的同步事务中，没有为了文件结构再拆一套service wrapper、通用PlanStep或等待协议。持久outbox和已完成阶段的SQL条件承担固定阶段的派发与等待。

实际新增模块、API、MCP与UI见../../agent-loop.md；验证见03-phases.md。未创建02-tasks.md，也没有继续使用task-doc-workflow。原计划中的Claude受限实施、动态派单、自动验收与全部故障窗口矩阵仍未完成，不把本次首版等同于整个长期方案完成。
