# 关键用例

实现证据：test/actions.test.mjs、test/fixtures/run-ledger-v4.sql、ui/react/features/scheduled/actions-draft.test.ts。

| 场景 | 检查 |
| --- | --- |
| 新建、更名、重启 | ID/地址和 secret 稳定，正文和定时保留 |
| 旧 Schedule | 扫描不改字节、默认关闭外部调用、暂停只映射定时 |
| JSON 输入 | 对象、数组、字符串、数字、false、null；配置不能被覆盖 |
| secret | 缺失/错误拒绝，修改立即生效，运行与提示无鉴权 secret |
| 请求错误 | 非 JSON、非法 JSON、额外字段、缺 data、超体积拒绝 |
| 同 Action 连续请求 | 独立落盘、按序、取消不执行、不按内容去重 |
| 并行与恢复 | 其他 Action 可执行；未启动队列恢复、未知执行中断 |
| 容量 | 1000 条队列后返回 429，不产生额外 Run |
| 启停 | 已接收队列不受之后编辑覆盖；定时/外部/整体独立 |
| 迁移 | v4 Run ID、快照、Session 保留；旧模糊队列不重放 |
| 端口/API/MCP | 外部端口无管理路由；Actions 与旧别名共享定义；MCP 去除 secret |
| UI | 无虚假时间也可保存；开关、secret 可编辑、来源和 data 可见 |
