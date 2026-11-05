# 验证范围

使用临时 Markdown 目录、SQLite、随机 loopback 端口、模拟 Runtime 和内存 MCP transport。禁止触发真实业务自动化。浏览器仅使用现有 playwright-headless，检查 Actions 列表、创建/编辑、无定时保存、secret 状态与 Run 输入；窗口为 1280px 和 390px。

先检查定义、输入与鉴权，再检查队列、恢复及管理/外部端口分离。全量测试与未修改 HEAD 的归档副本对照，使用同一依赖安装，区分既有失败。已有 Runtime 的超时、停止等行为通过相关测试回归，不增加第二套执行器。
