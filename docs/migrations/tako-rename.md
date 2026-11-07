# TAKO 更名与安装迁移

产品显示名为 TAKO，命令、包名、插件、MCP 和发布文件前缀为 `tako`。环境变量使用 `TAKO_`，HTTP 版本头为 `X-TAKO-Api-Version`。

## 当前状态

0.19.0 已正式发布，使用 TAKO 名称。GitHub 仓库已改为 `joisun/tako`，仓库 ID 1332808132 不变；更名前的 4 个分支、34 个 Release 和 181 个资产已核对保留。安装器支持将既有 UnderControl 程序和数据迁移至下方路径；已安装用户通过更新切换，本机尚未更新时仍使用原安装。

旧的公开提交、Release、校验值、原生 transcript 和历史迁移记录保持原样。0.18.0 当时使用 UnderControl，不能将旧资产或旧安装器改写为 TAKO。

## 新安装的入口

| 对象 | 名称或路径 |
| --- | --- |
| 命令 | `tako` |
| 数据 | `~/.config/tako` |
| 程序 | `~/.local/share/tako` |
| macOS 服务 | `com.joi.tako.daemon` |
| macOS 日志 | `~/Library/Logs/tako` |
| Linux 服务 | `tako.service` |
| Linux 日志 | `~/.local/state/tako` |
| 插件 | `tako@tako` |
| MCP | `tako`、团队执行用 `tako_loop` |

管理端口、HTTP Trigger 端口和开发入口保持原配置，默认分别为 43127、43128、43130。

本地构建的安装包可以先在隔离 HOME 验证：

```bash
TAKO_RELEASE_BASE_URL=file:///absolute/path/to/release \
  bash /absolute/path/to/release/install.sh --version v0.19.0 --no-start
```

真实切换需先结束或核对旧执行，再通过正常安装流程注册新服务。`--no-start` 不用于迁移仍在运行的旧服务。插件通过对应客户端重新安装新名称，新开会话才会加载新的 MCP 命名空间；已打开的会话不会被强行替换。

## 数据迁移和回滚

安装器继续使用 `server/migrate.mjs` 的事务流程，优先识别 UnderControl，再识别 Rillo 和更早的 recorder 安装。先核对路径冲突、服务归属、Action 执行和团队执行／组队状态，再停止旧服务、备份、移动目录、安装并验证新服务。

Action ID、secret、Markdown 正文、定时及执行设置、运行输入、历史快照、Session 关联和业务目录保持原值。仅更新应用拥有的配置路径，不在真实任务、数据库正文或原生会话内做品牌字符串替换。

SQLite 备份使用一致快照；IPC socket 只记录，不作为持久文件复制。备份和事务日志位于 `~/.local/state/tako-migrations`。新服务就绪前失败时，安装器恢复原目录、配置、CLI、current 指针及旧服务。路径冲突时不自动合并两份数据。

旧 UnderControl 数据、程序和日志目录保留到新位置的软链接。已有 Rillo → UnderControl 软链接仍然可解析，历史 Run 日志和 Session cwd 继续有效。再次安装会识别这些链接，不重复迁移；回滚只删除本次创建的链接。

## 旧格式的读取与新写入

| 内容 | 处理方式 |
| --- | --- |
| Action Markdown | 接受 `undercontrol/action`、`rillo/action`；保留整体启停和两个执行入口的状态。显式保存写入 `tako/action`。 |
| 旧 Schedule | 接受 UnderControl、Rillo 和更早的 Schedule 格式；旧 `enabled` 仍表示定时开关，外部调用默认关闭。 |
| 浏览器偏好与组队草稿 | localStorage 和 sessionStorage 使用同一迁移函数；TAKO 优先，缺失时依次采用 UnderControl、Rillo、recorder；写入失败保留旧值。 |
| 团队资料与锁 | 接受三代资料格式；已有锁文件继续用于同一份资料，避免更名后出现第二把锁。 |
| 历史团队消息 | 识别三代 Loop 工具名、团队上下文和 Session 决策标记。 |
| Agent 来源 | 读取 `tako_source`、`undercontrol_source`、`rillo_source`；新导入写 `tako_source`。 |
| Markdown 投影 | 显式投影时将旧 marker 更新为 TAKO，保留 marker 外用户正文。 |

环境变量、插件工具名和客户端版本头需要随安装一起更新，不把全部旧名称作为第二套长期活动入口。历史背景见 [UnderControl 迁移记录](undercontrol-rename.md)。

## 图形资源

0.19.1 使用新设计的章鱼 Logo、应用图标和深浅色横版字标。Dashboard、favicon、README 和插件资源均引用本项目生成的 PNG，使用说明见 [Logo 资源](../../assets/brand/tako/README.md)。可编辑 SVG 母版和吉祥物姿态仍待后续设计。

升级已打开的客户端时，安装器和客户端管理器可能保留旧插件文件供现有进程继续读取；旧插件不再注册为活动入口。新开会话后使用 `tako` 命名空间。
