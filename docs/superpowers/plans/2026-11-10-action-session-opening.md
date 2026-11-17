# Action 会话打开与 Fork Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the backend and coordinate the terminal/UI tasks with disjoint ownership. Track completion below.

**Goal:** Actions 恢复原会话前核对当前执行状态，并提供独立的 Codex Fork 打开入口。

**Architecture:** 复用已有 Codex 共享状态查询和 Run ledger，在后端强制执行恢复检查。Fork 通过已安装 CLI 的原生 `codex fork <source-id>` 打开新会话，不改 Action 绑定。沿用现有 Terminal、Otty、Ghostty 路由与 Actions 工具栏。

**Tech Stack:** Node HTTP、SQLite、Codex CLI、React、TanStack Query、现有 shadcn Button。

**Spec:** 本次对话用户提出的两点：打开原会话前判断活跃状态；新增 Fork 会话打开入口。仅修改这两点，不改变定时调度策略，不自动提交或发布。

## Global constraints

- 会话正在执行或状态无法核实时禁止恢复原会话；前端状态展示与后端点击时检查均执行。
- 不能只检查所选历史 Run；同一 Session 的其他进行中 Run 也阻止恢复。
- Codex 原生状态来自已有共享服务的只读查询，不通过文件时间、进程猜测或实际 resume 探测。
- 原生查询仅覆盖其连接的共享服务；未知进程或检查后发生的状态变化仍由 Codex 的写入保护处理，不宣称全机原子锁定。
- Fork 允许从已保存历史打开独立副本，保留 Action 主会话绑定；共用原工作目录，不表示文件隔离。
- Fork 不定位或复用原会话 pane，也不写入 Run 的 session_id；原有恢复定位行为保留。
- OpenCode 保留原恢复行为，本轮不增加其 Fork；Linux 不提供本机终端按钮。
- 验证不打开真实终端、不启动模型、不修改用户任务；终端命令使用依赖注入检查，浏览器写请求使用隔离夹具。

## Interfaces

- `terminalLauncher.launch({...existing, mode?: 'resume'|'fork'})`：默认 resume；fork 仅支持 Codex，执行原生 `codex fork <source-session-id>`，不复用原 pane。
- `GET /api/v1/scheduled-runs/:id/session-opening` 与 `/api/v1/runs/:id/session-opening`：`{session:{state:'active'|'idle'|'unknown',can_resume:boolean,can_fork:boolean,reason:string|null}}`。
- `POST /api/v1/scheduled-runs/:id/fork` 与 `/api/v1/runs/:id/fork`：空 JSON body；事实来自 Run，返回原有 `RunResumeResponse` 形状。
- `sessionResume.sessionOpening(runId)`、`resumeScheduledRun(runId)`、`forkScheduledRun(runId)`。
- `DashboardApi.scheduledRunSessionOpening(id)`、`forkScheduledRun(id)`；原 `resumeScheduledRun` 保留。
- `runService.resumeTarget(id,{allowActive:false})` 保持默认保护，Fork 与状态查询可请求允许读取活跃目标；`runService.isSessionActive(runtimeId,sessionId)` 检查整个 ledger。
- 原生 activity/snapshot 支持可选 `{fresh:true}`，恢复前重新读取；GET 展示使用现有短缓存。

## Tasks

- [x] 后台：先补活动历史会话、原生 active/unknown、状态变更、Fork 不改绑定的回归；接入状态查询、恢复检查和 HTTP 入口。
- [x] 终端：先补默认恢复、原生 Fork、Otty/Ghostty 不定位原 pane、参数校验测试；接入 mode 参数。
- [x] 前端：新增状态轮询和 Fork 图标按钮，覆盖 active/idle/unknown、后台拒绝、Linux 和 OpenCode；API 使用空 body。
- [x] 集成：检查文档，运行相关测试、类型/语法检查和构建，在浏览器验证真实页面布局与隔离状态变化，审查差异。

## Verification record

- 当前基线 main / c319802，工作区起始干净，本机正式版本 0.20.1。
- 红绿回归确认旧实现没有状态/Fork 接口，且未阻止历史 Session 冲突。显式 fresh 检查还会等待旧的进行中查询后重新读取，避免复用点击前的旧结果。
- 后端最终全量 633/633、UI 全量 116/116；206 个源码语法检查、生产类型检查、前端构建与差异检查通过。
- 同一构建的 Actions 页面配合隔离真实 HTTP 服务，验证 active/idle/unknown、Fork 命令、状态显示空闲后后台拒绝、原 Action 绑定保留，以及 390px 宽度下三个图标按钮可见。无浏览器异常，无生产写请求，无真实终端或模型启动。
- 独立复审发现扫描期间的原生状态通知只阻止缓存、未阻止旧 idle 结果返回；已添加红绿回归，将已失效扫描返回为 unavailable，不缓存、不关闭连接、不循环重试。复审确认恢复 guard 返回 unknown/HTTP 409，未调用 launcher，P2 关闭。
- 本轮改动留在 main 工作区，未提交、发布或更新正式安装；隔离验收服务在结束后关闭。
