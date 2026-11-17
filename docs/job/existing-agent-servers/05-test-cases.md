# 验证矩阵

| 场景 | 预期 |
| --- | --- |
| socket 不存在或断线 | 返回不可用；不启动 app-server，下次查询可重连 |
| 多个请求与历史大响应 | 独立匹配回包，超限拒绝，服务存活 |
| 创建 Run | 会话配置独立，MCP 凭据放入 env，共享 PID 不进入 Run |
| 继承已加载会话 | 明确拒绝，不启动 turn 或静默换新会话 |
| 取消和超时 | 仅 interrupt 目标 turn，确认结束后释放目录 |
| 任务连接异常 | 结果不明时目录占用保持 unknown，server 不被终止 |
| Claude 自动执行 | 能力不可用，不调用 SDK query、CLI worker 或 agents 探测 |
| Claude 终端 queue | 仅使用已有匹配终端，不声明原生接收回执 |
| REST 运行和追加 | 复用预先存在的伪 app-server，保留事件与结果 |
| 真实服务只读 | 已有 PID 不变，没有创建新 app-server 或模型调用 |
