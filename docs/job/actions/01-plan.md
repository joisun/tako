# 实施计划

## 已检查的架构

现有 `schedule-definition-codec/repository` 负责 Markdown、原子写和 etag；`scheduler-service/clock` 管理定义和定时；`run-store/service` 使用 SQLite 保存快照并调用共用 Agent 执行器；daemon 组装管理 HTTP、MCP 代理和 React 界面。现有同 Action 排他索引包含 queued，重启会中断全部未完成运行，需要调整才能可靠排队。

## 步骤

1. 定义兼容：可选 cadence、独立 schedule_enabled/external_enabled/external_secret，默认旧任务不开外部调用；secret 在执行快照边界移除。
2. 运行与监听：Run v5 保存 input_json；同 Action 按持久化顺序串行，启动时确定继承 Session；仅恢复未启动队列；独立有限流/体积限制的外部 HTTP。
3. 产品与契约：导航 Actions、复用编辑器和详情、展示地址/secret/示例/data；Actions 管理 API/MCP 与旧入口共用实现。
4. 验证与文档：临时定义、模拟执行器和 HTTP 覆盖迁移、鉴权、输入、队列、恢复、端口隔离；检查类型、构建和相关测试，更新活动文档。

## 验收边界

不运行真实自动化，不扩大 Agent 权限，不执行外部 data，不另建执行器或数据库。已启动但结果未知的运行保持 interrupted，不盲目重试。停用入口不取消已接收的队列。
