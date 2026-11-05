# 验证结果

2026-11-04，在 feature/actions 独立工作区完成。没有真实 Agent、Linear 或公网操作，没有提交和推送。

## 通过

- `node --test test/actions.test.mjs`：15/15，包括真实 loopback HTTP、SQLite、v4 SQL 固定样本及内存 MCP client/server。
- 相关后端组合：72/72（当时含 14 项 Actions 用例；之后新增队列容量用例单独随专项通过）。
- `npx vitest run` 指定 actions-draft、schedule-draft、schedule-fast-mode、dashboard-api：20/20。
- `node scripts/check-syntax.mjs`：202 个源文件通过。
- 生产源代码 TypeScript 检查：排除现存测试文件后通过；临时配置继承原 tsconfig，无仓库配置改动。
- `npm run build`：退出码 0，更新预构建 ui/dist/react.html。
- `git diff --check`：通过。
- Playwright：临时 UI 创建无定时 Action，启用外部调用并保存；再次打开确认 secret 为可见/可编辑文本且已安全生成、URL 包含稳定 ID。Run 展示外部来源与 DEMO-1 输入，Escape 返回原控件焦点。1280px、390px 无横向溢出，窄屏弹窗宽 358px。截图中的 secret 已遮盖；未对真实 CLI 执行作 UI 验收。

## 全量检查与基线

- 当前 `npm test`：579 通过、7 失败，共 586。
- 未修改 HEAD 的归档副本：563 通过、8 失败，共 571。当前剩余 7 个失败全部存在于基线：旧 Host/Origin 403 断言、Codex steer 旧模拟回执、旧 UI toolchain/状态文案断言。本次不恢复用户已明确取消的访问拦截。
- 当前 `npm run test:ui`：58 通过、22 失败，共 80；另有既有 design-system 导入失败。基线 55 通过、23 失败，共 78；剩余失败均为既有会话交互/投影、设计系统、旧导航与事件断言。
- `npm run check`：语法通过，完整类型检查失败，当前与基线均为相同 5 个错误：design-system.test.tsx 的缺失组件导入/Tooltip 参数，以及 dashboard-event-source.test.ts 的旧函数参数。没有新增生产类型错误。

## 范围与限制

外部触发默认本机监听 43128。使用者自行配置公开 URL、frp 与第三方转发；本次未部署。Codex/OpenCode 沿用现有适配器，未新增 Runtime，也未在真实业务任务上做端到端执行。主目录和其他工作区未修改，已有 58019 等预览服务未操作。

相关文档已扫描并同步 README、架构、Agent Loop 的共享库版本、更名迁移指引及 docs/actions.md；历史任务日志与 specs 不作为现行契约重写。

## 2026-11-05 真实 Codex 调用验证

使用独立本机数据目录、管理端口 55847 和触发端口 55848。创建 `curl 连通测试（low）`，Action ID 为 `b1255c81-319e-4041-9351-4d54877f58ea`。使用本机实际模型目录中的 `gpt-6.1-sol`，推理强度为 `low`。关闭定时执行，仅回显输入，不修改文件或调用业务服务。

- curl 返回 HTTP 202，随后真实 Codex Run `34796243-c6c4-4fb0-9657-7d8b40943062` 完成，状态为 `succeeded`。
- 原生 Session 为 `01a1aa99-530a-74d0-909b-1f810d0916f4`。
- 最终结果可作为单条 JSON 解析。`received` 与请求的 `data` 完全相等，Run 输入保持相同结构和值。
- SQLite 中执行快照的 `reasoning_effort` 为 `low`。鉴权 secret 不在 Run 输入或执行快照中。
- 实测发现 Hook 续轮增量混入正式结果，已在适配器中分离。新增对应回归用例并执行，通过 1/1。
- 本轮输入说明已明确区分外层输入对象和 `data` 值，避免回显多套一层。
- 再次执行 `node --test test/actions.test.mjs`，通过 15/15。

布局预览端口 55846 的 curl 示例已指向该测试 Action。布局预览不保存配置，实际编辑与运行记录使用 55847。真实 Linear 任务、其他工作区和公网未操作，没有提交或推送。

## 编辑页一致性修复

上述独立布局预览未同步到真实编辑器，造成两个入口展示不同版本。现已关闭 55846，统一使用 55847 的真实编辑页。

- 两个执行入口在开启后展示配置。HTTP Trigger 关闭再开启保留原 secret。
- 多段生效时段可添加，切换定时开关不丢失编辑中的时段。
- Agent 在默认折叠的高级设置中，位于 Model 之前，测试 Action 的 Reasoning 保持 low。
- 调用地址和 Secret 使用输入框内复制图标，curl 代码块复制到剪贴板的内容与展示一致。
- 真实编辑页保存后重开，Secret 保持稳定，定时仍关闭，高级设置默认折叠。390px 页面无横向溢出，弹窗页头和页脚保持可见。
- 相关前端用例通过 12/12，`npm run build` 通过。

## 0.17.0 发布准备

用户已授权提交、发布和更新本地，并明确要求丢弃测试文件。本工作区的 8 个已跟踪测试修改和 3 个新增测试文件已丢弃，不包含在发布提交中。上述专项结果是开发阶段的历史记录。

- 生产源码严格 TypeScript 检查通过，临时配置仅排除测试文件，不修改仓库 tsconfig。
- 202 个源文件语法检查、安装脚本语法检查与 `git diff --check` 通过。
- `npm run package:release` 生成 macOS、Linux 和两个客户端 adapter，校验清单包含安装脚本与四个压缩包。
- 使用真实发布目录执行 `scripts/verify-release-install.sh`，macOS 隔离安装 0.17.0，Dashboard、健康接口、SSE 和运行版本检查通过。
- Codex 和 Claude adapter 的打包产物通过实际 stdio MCP 初始化与 tools/list，均返回 35 个工具，包含 action_list、action_get、action_create、action_update。
- 完整检查仍有既有类型错误和过时测试失败，不视为通过。沿用 0.16.1 的手动发布方式，CI 和 Release workflow 保持原样。未进行 Linux 实机安装验证。
