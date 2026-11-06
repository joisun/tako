# 状态

status: implemented
current_task: 源码和品牌基础已落地，安装切换待发布时执行

分支：`feature/tako-rebrand`，基于 main 的 `5e43aa4`。全部任务修改位于独立 worktree，main 未改动。未提交、推送或发布。

## 实际改动

- 现行产品、CLI、包、插件、MCP、环境变量、版本头、服务、开发及发布文件统一为 TAKO / tako；新包准备版本为 0.19.0，未覆盖原有 0.18.0。
- 使用文字字标，延续原有中性深色界面、Geist 字体和导航；主操作使用品牌紫色，焦点使用浅紫色，状态色保持语义。旧图形不作为 TAKO 标志继续展示。
- 接受 UnderControl / Rillo 的 Action、Schedule、团队导出、来源元数据、投影 marker、Session 决策及工具标签。旧 Action 的整体停用状态不会被误读为旧 Schedule 的定时暂停。
- 浏览器 localStorage 和 sessionStorage 统一迁移，TAKO 优先于 UnderControl、Rillo 和 recorder，保存失败保留原值。
- 复用事务迁移并补齐 UnderControl 安装、已有 Rillo 软链接链、真实路径比对、团队与组队中的执行保护。数据库备份、路径冲突检查及回滚继续使用原流程。
- 新 Logo、favicon、Banner 与章鱼形象未设计、未生成；来源素材包 SVG 未采用。旧公开版本和历史文件保留原样。

## 验证

2026-11-06，全部在本 worktree 或隔离临时目录执行：

| 检查 | 结果 |
| --- | --- |
| 语法检查 | 通过 |
| 生产代码 TypeScript（临时配置，仅排除测试文件，未改项目配置） | 通过 |
| `npm run check` | 未通过：原有 design-system.test.tsx 与 dashboard-event-source.test.ts 的旧组件／参数接口错误，共 7 条 |
| 更名、格式和安装迁移测试 | 29 / 29 通过；覆盖 ID、secret、正文、定时暂停、不可变历史、Session 引用、别名链、回滚、旧锁、团队资料与 Agent 来源 |
| 浏览器偏好迁移测试 | 4 / 4 通过 |
| `npm test` | 573 通过、20 失败；与 main 5e43aa4 的隔离副本对照，剩余失败名称均在原有失败集合内 |
| 全量 UI 测试 | 56 通过、23 失败，另一个旧 design-system suite 无法加载；原始隔离副本为 53 通过、25 失败及同一加载问题 |
| 发布打包 | macOS、Linux、Codex、Claude 四个 TAKO 包构建成功 |
| 最终包隔离安装 | 使用临时 HOME、随机本机端口和空数据，安装 0.19.0 后 Dashboard、meta、SSE 验证通过，临时服务已结束 |
| 两个插件归档 | 解包后以 stdio 初始化，serverInfo 为 tako，均列出 35 个工具并包含 action_get；未启动模型、未执行业务任务 |
| 实际页面 | 43130 的 Sessions、Actions、Teams 均显示 TAKO，导航顺序保持；已查看截图，品牌区无旧图形、无横向溢出，控制台无错误 |
| 差异检查 | git diff --check 通过；无新增依赖 |

全量测试保留原有行为断言，不跳过或降低发布校验。遗留问题涉及已移除的 Host/Origin 拦截断言、旧 UI 组件接口、Schedule→Actions 的旧预期及其他既存用例。本轮仅同步直接涉及品牌的测试名称、路径、版本头和预期。

## 预览和未执行的切换

唯一开发预览为 http://127.0.0.1:43130/，源码来自本 worktree，API 仍连接现有 43127 服务。没有创建新的一套真实数据或执行系统；浏览器只核验显示，没有发送业务任务。

真实 GitHub 仓库仍为 joisun/undercontrol，仓库 ID 1332808132；本机仍使用 UnderControl 服务、插件和数据目录。已确认本机 gh 有仓库管理权限，但未执行远端更名。本轮不重启真实服务、不迁移真实数据、不操作 Linear 自动化。最终安装和客户端插件切换按 [迁移文档](../../migrations/tako-rename.md) 在后续发布时执行。

品牌约定见 [品牌基础](../../brand/tako-foundation.md)。构建日志、完整测试输出与隔离安装包保存在本 worktree 的 `node_modules/.cache/tako-rebrand/`，不进入版本控制。


## 0.19.0 发布准备

用户于 2026-11-06 明确要求提交、发布并更新本机。

- GitHub 已更名为 joisun/tako，仓库 ID 不变；4 个分支、34 个历史 Release、181 个资产保持一致。
- 发布前已修正旧品牌、旧 UI 组件、旧 Schedule 队列／恢复和已移除访问拦截的测试预期。没有减少发布检查步骤，没有跳过失败用例。
- 发现自动压缩配置移除提交 d68ff14 意外同时删除了 Action 标题、正文、目录和客户端的处理，已按该提交之前的行为恢复。现有测试覆盖这个问题。
- Node 全量测试 593/593、UI 全量测试 83/83、生产及测试 TypeScript 均通过。语法检查覆盖 206 个文件。
- 本机两条 unknown 历史执行的原进程已不存在；对应原生日志最后事件均为 2026-11-05 的 turn_aborted。安装前将通过现有 reconcile 接口登记中断，不重跑任务。
- 客户端和旧服务配置已备份到本机 .local/state/tako-rename。正式数据备份仍由安装事务执行。
- 根据用户 Git 规则，35 个测试文件的提交已单独请求授权；授权到达前不提交测试、不触发发布。非测试源码提交沿用本次用户授权。
