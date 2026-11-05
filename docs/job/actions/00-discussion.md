# Actions：已确认范围

用户已确认本设计并授权直接开发；不提交或推送。Actions 升级现有 Schedule，Markdown 仍是定义事实来源，Run 和 Session 复用现有系统。

独立监听端口只接受 `POST /actions/<id>/trigger`，JSON 为 `{secret,data}`。secret 明文保存在 frontmatter，仅管理接口可读；data 是不可变运行输入，不能改变执行配置。定时可选，整体启停、定时启停和外部调用启停独立。

旧定义只读不改写，普通管理保存写为 `rillo/action`，保留 ID、路径和正文。旧 API/MCP 调用同一实现。真实 Linear 任务与现有预览服务不操作。无业务去重、第三方验签或隧道部署。
