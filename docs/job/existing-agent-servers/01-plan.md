# 实施方案

## 连接与执行

统一使用现有 `codex-shared-client.mjs` 连接数据根下的 Unix socket。Sessions、历史、搜索、模型查询和 Run 执行均通过 RPC 请求已有服务，删除 stdio 子进程客户端与 CLI queue 备用路径。

任务配置通过 `thread/start` 或冷恢复的 `config` 传递；Skills 与扩展能力保持本轮设置，团队 MCP 使用显式环境变量。新任务配置 `thread_unload_delay_secs=0`，结束后退订并等待 Codex 卸载空闲线程，服务继续运行。已加载的目标会话拒绝继承。检查与 resume 之间不是原子操作，不能宣称跨客户端全局锁。

取消和超时只调用目标 turn 的 interrupt，并核对结束事实。无法确认执行停止时返回 `execution_stopped:false`，目录占用保持 unknown，不登记共享服务 PID。

## Claude

用户已确认暂时禁用 Claude 自动执行。删除 SDK 和 CLI worker；能力查询返回不可用。保留已有终端 queue、元数据读取与任务历史。

## 验证

用临时 Unix socket 伪服务验证连接、执行、追加、取消、断线和服务器存活，禁止测试调用真实模型。完整后端测试使用隔离的 CODEX_HOME 和 CLAUDE_CONFIG_DIR。最后仅对现有真实共享服务发只读请求，检查前后 app-server PID 不变。

源码与相关现行文档完成后，按用户追加授权发布 0.21.0 并更新本机服务。升级保持用户数据和 Agent 全局配置。
