# Teams 文件收发 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement the following tasks, with disjoint backend delegation where useful. Track completion with the checkboxes below.

**Goal:** 用户可选择、粘贴、拖拽图片或 PDF 发给团队，并预览、下载 Agent 登记交付的文件。

**Architecture:** 保留 Tiptap Mention、现有消息 API 和附件元信息。浏览器把文件内容传给本机服务保存，再复用当前附件校验及 Agent 输入。产物读取以团队、Run 和已登记引用为边界；交付可以在既有 deliver 动作携带 artifacts，无须为了文件再发一份重复报告。

**Tech Stack:** React、Tiptap 3、现有 shadcn/Base UI 组合、Node HTTP、SQLite。

**Spec:** 本次对话的文件收发调研及用户“先提交代码，然后推进”指令。滚动修复已独立提交为 `237d636`；本任务继续在 main 实现。用户随后明确要求提交所有 changes、发布并更新本地，本轮连同看板负责人展示发布为 v0.20.1。

## Global Constraints

- 沿用 PNG、JPEG、WebP、GIF、PDF，单文件最多 20 MiB，每消息最多 8 个；允许附件消息正文为空。
- 选择、粘贴、拖拽进入同一上传函数；保留文本粘贴、Mention、快捷键、失败草稿和滚动行为。
- 文件保存到服务管理的数据目录；原文件不变。已有服务器路径引用 API 继续可用。
- 交付文件只读取当前团队指定 Run 的已登记 artifacts；校验真实路径及项目边界，不根据任意消息文字开放磁盘路径。
- 普通相对路径指向 Task 内部目录；project:N/path 指向对应资源。预览 HTML/SVG 等主动内容时显示源码，下载返回原始内容。
- 已归档产物优先读取原快照；没有快照时读取经登记和路径校验的当前文件。文件丢失明确报错。
- 测试只使用临时数据或浏览器夹具，不启动真实 Agent，不修改用户任务。
- 按用户本轮授权提交源码、文档和新增测试；发布使用现有 Release workflow，本机使用已验证的正式安装包。

## Interfaces

- `POST /api/v1/teams/:room/attachments/upload`：原始文件字节，Content-Type 为文件类型，X-File-Name 为 encodeURIComponent(filename)；返回 `{attachment: LoopAttachment}`。
- `GET /api/v1/teams/:room/artifacts/:run?reference=...`：原文件；`download=1` 返回下载；`preview=1` 返回 `{artifact:{name,media_type,size,text?:string,truncated?:boolean}}`，正文最多 128 KiB。
- `request_action(action=deliver, reason, artifacts?)`：可选 0–32 个现有相对文件引用；保存到 Run.action.artifacts，归档与 UI 同时读取此处和 submission.artifacts。
- `DashboardApi.uploadRoomAttachment(roomId,file:File)`、`roomArtifactPreview(roomId,runId,reference)`、`roomArtifactUrl(roomId,runId,reference,download?)`。
- 团队响应的 `artifact_runs` 返回最近 100 个已登记产物的 Run 元信息（含历史成员快照，parts/result 为 null），让新任务保留旧交付入口；原生片段和凭据不重复传输。

## Review Focus

- 混合文字/图片剪贴板保留文字，纯图片粘贴附加图片；非文件拖拽保持编辑器原行为。
- 上传超限、格式不符和发送失败保留可恢复状态；上传中不能把未保存附件发送给 Agent。
- 只附文件也能创建及继续任务，重试维持既有幂等约束。
- 相同名称文件内容不同不会覆盖；伪造 MIME、越界引用和跨团队 Run 无法读取。
- Artifact 不依赖重复结果正文才能展示；缺失文件错误可见；关闭预览后阅读位置不变。

## Tasks

- [x] 1. 后端文件收发：先添加行为测试并观察失败；接入有界上传、附件消息、deliver artifacts、团队产物预览和下载；验证路径边界、归档与旧引用。
- [x] 2. 输入框：先添加交互测试并观察失败；接入现有编辑器容器的文件事件及文件选择器，附件缩略图、移除、失败重试及仅附件发送。
- [x] 3. 产物界面：渲染 Run 正式产物为紧凑附件入口，使用现有 Dialog/Markdown/Code Block 展示并提供下载；包含无原生时间戳、跨任务历史入口的红绿回归。
- [x] 4. 集成：更新受影响文档，重建前端，运行相关测试、类型/语法检查与项目回归；源码预览验证滚动，同一构建的临时同源后端验证真实附件和原生下载。

## Verification Record

- 2026-11-10：已有滚动修复重新通过 83 条 UI 测试、`npm run check`、前端构建，提交 `237d636`。
- 文件输入使用现有容器的原生 paste/drop 事件，接入已有 Tiptap，无新增依赖。混合剪贴板保留文本，纯图片进入附件。
- 本机真实 HTTP 后端与同份构建的浏览器验证了选择、粘贴、拖拽、仅附件发送、失败重试、草稿及请求标识保留、稳定成员 Mention、摘要一致、刷新后的附件、Markdown/PDF 预览及中文文件名原生下载；真实 Agent 执行数为 0。
- 1346×753 与 390×844 的文件预览无横向溢出；PDF 原生查看器已实际显示文档。HTML/SVG 显示源码，文件响应保留 sandbox 与 nosniff。
- 原有 Sessions Fork 测试在并行检查时提前断言关闭动画已完成；改为等待 DOM 移除，断言内容不变，未修改 Sessions 产品逻辑。
- 独立审查发现跨任务文件入口缺失；已增加团队范围的有界产物 Run 索引及有/无旧消息正文的回归。浏览器确认开启新任务后旧交付入口仍保留，复审通过。
- 并行回归暴露 PDF Worker 清理时调用不存在的 `pdf.destroy()`；直接等待 Worker 正常退出的测试稳定复现，按当前 unpdf API 改为 `pdf.loadingTask.destroy()` 后通过。
- 最终并行回归：后端 612/612、UI 97/97；`npm run check`（206 个源码文件语法检查及生产类型检查）、`node ui/build.mjs` 和 `git diff --check` 通过。
- 文件收发的完整验收使用隔离临时服务，未改变本机任务或触发真实 Agent。源码预览 43130 代理本机 43127；新增后端接口随 v0.20.1 安装提供。
- 发布前功能回归通过后端 612 条、UI 97 条、类型及语法检查。v0.20.1 macOS 安装包在临时用户目录实际安装并启动，版本、Dashboard 和 SSE 检查通过。
- v0.20.0 的 GitHub 构建在依赖下载阶段遇到 npmmirror 503/504。v0.20.1 将锁文件中的 108 个镜像 URL 改为 npm 官方源，依赖版本及完整性校验值保持不变；已核对两项实际失败包的官方 tarball 与原校验值一致。
