# Agent Loop 讨论与范围

## 背景

用户希望把个人本机的多Agent房间协作作为Rillo的新功能线。代表性场景是找回已有讨论，由多个Agent讨论，指定成员实施，再验证和交付。主要机制参考Multica固定版本资料，交互参考AI Hive房间截图。

## 材料与事实

- Spark及需求、架构、ADR位于本机Obsidian的`Sparks✨/Agent Loop 协作系统/`。它们是设计材料，没有已实现的产品代码。
- Multica依据是研究归档的固定commit `2083970b51c03c0773188636c24a96acd09ad4c3`，尤其是Squad分派协议、mention路由、持久wakeup和会话恢复；本轮不复制上游代码，不把它描述为最新版本行为。
- Rillo基线为`91f0870`（v0.16.1），单Node daemon，React/TypeScript界面，Codex/OpenCode执行runtime，Codex/Claude消息控制provider。
- `scheduled_runs`强制schedule_id，且同一Schedule只允许一个活动Run。现有RunService也要求Schedule快照，不能直接作为房间并行派发接口。
- Run SSE和revision hub只保留内存状态，不能作为跨重启的Loop事件日志。
- 已退休Tasks是原生会话的重复投影；协作Task保存用户目标、授权、分工与验收条件，不读取或迁移旧tasks.sqlite。

## 范围确认

用户原话：“开始推进，最好新建一个 worktree”。这授权在Rillo的独立worktree推进已讨论的协作功能线，先完成增量架构与实施计划。范围以本轮对话、现有spark需求和本机优先约束为依据；详细API、持久化方案和执行阶段计划仍需以具体方案确认，不能声称已经获批。

- 分支：`feature/agent-loop`。
- worktree：项目根目录`.worktree/feature-agent-loop`。
- 目标闭环：房间发起任务→讨论→指定成员实施→验证→交付，支持暂停、继续、取消与可解释的恢复。
- 复用现有UI体系、原生会话查询、runtime探测与CLI执行基础设施；保持Sessions/Scheduled既有行为。
- 人已授权“讨论后执行”时不重复询问阶段许可；新的修改范围或权限超出授权时才等待人。

## 本轮工作方式

最初采用task-doc-workflow保存规划；用户随后明确停用，后续直接自主实施，不再设置其确认门槛。当前没有writing-plans/superpowers/gstack等通用工程执行skill，由agent完成证据核对和架构规划。结构化提问工具已可用，不修改Codex配置或feature flag。

原始交付为增量架构和实施计划；用户随后授权自主实现，实际交付及限制以03-phases.md为准。未授权自动提交、合并、发布或迁移生产数据。

## 排除范围

多租户、远程机器配对、白板/Workflow编辑器、向量数据库、全部provider、自动提交合并部署；不修改本机正式计划，不接管外部终端内正在运行的会话，不恢复历史Tasks功能，不复制完整原生transcript。

## 需要通过实验确定

- Claude执行runtime、Codex/Claude只读能力、停止确认及恢复；已有消息适配不能替代这些证明。
- 同目录资源互斥、进程身份对账、启动边界崩溃及重复结果。
- 固定阶段下的讨论预算、无进展判断和结果验收效果。

## 方案中要明确的取舍

建议首版先保留scheduled_runs和既有API，新增协作数据并抽取共同执行驱动，避免首个里程碑就搬迁全部历史Run。此建议将在增量架构中给出实现边界和替代方案，不当成用户已确认的细节。

## 本机资料入口

- [原始spark](</Users/joi-com/Desktop/obsidian/Sparks✨/Agent Loop 协作系统/spark.md>)
- [首版需求](</Users/joi-com/Desktop/obsidian/Sparks✨/Agent Loop 协作系统/requirements.md>)
- [原始架构草案](</Users/joi-com/Desktop/obsidian/Sparks✨/Agent Loop 协作系统/design/architecture.md>)
- [Multica固定版本研究](</Users/joi-com/Desktop/obsidian/ai/01_research/20261030_research_multica.md>)

这些为用户本机资料引用，不复制到仓库。接续者没有这些路径时先读取本任务的范围摘要和Rillo增量架构，不能伪称已核验上游最新行为。
