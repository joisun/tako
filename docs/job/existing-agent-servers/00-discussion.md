# 范围与依据

用户要求 TAKO 只尝试连接机器上已有的 Codex / Claude 服务；连接失败不得启动新实例。目的是消除 TAKO 频繁创建 Codex 后台进程引发的插件目录下载。

本轮覆盖 Sessions 历史查询、Actions / Teams 执行、消息发送及其自动回退路径。用户主动点击“在终端打开 / Fork”属于显式启动交互式客户端，保持既有功能。OpenCode 不属于本次要求。

已有 Codex 共享 Unix socket 客户端可复用；当前 Sessions 和运行历史仍启动独立 stdio app-server。Codex 执行也使用每 Run 一个进程，并依赖进程退出释放目录占用；迁移后必须改为确认 turn 结束，不能把断开 socket 当作任务停止。

Claude 无已接入的稳定本地实例连接接口。用户已确认暂时关闭自动执行，保留已有终端消息入口和历史。用户明确不复制或 Fork 会话；本轮保持原 Session ID 的继承逻辑，不调整继承上限或会话策略。

用户已明确授权实现以上目标，并追加授权提交、push、发布和更新本机服务。不修改任务数据或全局 Codex / Claude 配置。Context7 查询被限流，改查两家官方文档和当前版本源码。
