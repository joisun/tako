# UnderControl 更名与安装迁移

产品名为 UnderControl，命令、包名、MCP、插件和发布文件前缀为 `undercontrol`。环境变量使用 `UNDERCONTROL_`，HTTP 版本头为 `X-UnderControl-Api-Version`。

## 当前状态

GitHub 仓库已改为 [joisun/undercontrol](https://github.com/joisun/undercontrol)，仓库 ID 1332808132 不变。4 个分支 SHA、33 个 Release、175 个资产的 ID、名称、大小和 digest 已核对保持一致。历史 Git 对象、Release 文件和校验值不改写。

0.18.0 使用新的命令、插件标识和发布资产名称，本机已完成安装迁移。更早的 Release 保留原始名称的程序和资产。

本机活动入口为：

- CLI：`undercontrol`。
- 数据：`~/.config/undercontrol`。
- 程序：`~/.local/share/undercontrol`。
- macOS 日志：`~/Library/Logs/undercontrol`，launchd label：`com.joi.undercontrol.daemon`。
- Linux 日志：`~/.local/state/undercontrol`，systemd unit：`undercontrol.service`。
- 插件：`undercontrol@undercontrol`，MCP server：`undercontrol`。
- 本地 marketplace：`~/.local/share/undercontrol/marketplace`。

页面和外部触发端口保持原配置。Action ID、secret、任务指令、执行策略、运行输入、历史快照与 Session 关联不因改名而重建。

## 安装器迁移旧数据

安装器复用 `server/migrate.mjs` 的事务迁移。先核对旧服务归属、目标路径冲突和正在运行的任务，再停止旧服务，备份 SQLite 与持久文件，移动路径并注册新服务。新服务就绪前失败会恢复旧目录、配置、CLI 和服务。

备份与事务日志保存于 `~/.local/state/undercontrol-migrations`。用户安装切换前另行备份的客户端配置与插件位于 `~/.local/state/undercontrol-rename`。两套独立的数据目录同时存在时不覆盖或合并。

旧数据、程序与日志目录保留指向新位置的迁移软链接，供历史 Run 日志路径、原生 Session cwd 和已有绝对路径引用读取。迁移器识别这些软链接，重复安装不再次迁移。失败回滚会先删除自己创建的软链接，再还原目录。旧 CLI 不再作为活动命令。

外部 Markdown、数据库中的历史正文、已发布版本目录和原生 transcript 不做品牌字符串替换。配置中由应用拥有的旧目录路径迁移到新目录；用户业务目录保持不变。

已构建的本地包可按以下方式安装：

```bash
UNDERCONTROL_RELEASE_BASE_URL=file:///absolute/path/to/release bash install.sh --version v0.18.0
undercontrol status
```

## 旧标识的读取兼容

旧名字只出现在兼容入口和明确标注的历史资料中：

| 位置 | 保留原因 |
| --- | --- |
| 安装迁移器、旧 launchd 清理 | 识别并安全迁移旧服务、目录和命令。 |
| Action Markdown 解析器 | 接受 `rillo/action`、`rillo/schedule` 和更早格式；新建或显式保存写 `undercontrol/action`。 |
| 浏览器偏好迁移 | 将旧产品 key 迁至 `undercontrol`；写入失败保留原值。 |
| 团队历史消息与工具显示 | 继续识别旧原生会话中的 `rillo_loop` 工具和团队上下文。 |
| Session 决策读取 | 兼容历史结果末尾的旧决策标记，新的模型输入使用新标记。 |
| 团队资料恢复与锁 | 读取旧资料格式；已存在的旧锁文件继续协调同一份资料。 |
| Agent 定义来源 | 读取已有定义的旧来源字段，新的导入使用 `undercontrol_source`。 |
| 旧任务文档投影 | 已存在的旧标记在下一次显式投影时迁至新标记，保留标记外正文。 |
| 历史 job、Git 引用与公开资产 | 保留真实执行记录、版本与原始链接，不伪造已完成的远端发布。 |

此前更名为 Rillo 的记录见 [历史迁移记录](previous-brand-rename.md)。

新发布产物为 `undercontrol-macos.tar.gz`、`undercontrol-linux.tar.gz`、`undercontrol-codex-adapter.tar.gz`、`undercontrol-claude-adapter.tar.gz`、`install.sh` 和 `SHA256SUMS`。

插件更名后需要新开 Codex 或 Claude 会话加载新命名空间；已打开的客户端会话不会在运行中替换 MCP 工具。
