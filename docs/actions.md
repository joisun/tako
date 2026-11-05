# Actions

Actions 是 Schedule 的升级。一个 Markdown 文件定义一个 Action；定时、手动和外部 HTTP 共用 `RunService`、Run ledger、Runtime 和原生 Session，不存在另一套执行器。

## 定义与启停

默认定义目录仍是 `~/.config/rillo/schedules`，沿用 `schedule_definitions_dir` 设置、文件监听、原子写入和 `etag` 并发保护。新建及管理保存使用 `type: rillo/action`：

```yaml
---
type: rillo/action
id: 8b4a8b25-3d1e-4e43-8f5f-9cbef95b9275
title: Issue follow-up
enabled: true
schedule_enabled: false
schedule: null
external_enabled: true
external_secret: replace-with-your-own-secret
workspace: /Users/me/projects/example
agent: codex
sandbox: read-only
capabilities:
  skills: disabled
  integrations: inherit
thread_mode: reuse
max_inherit_runs: 20
timeout: 2h
---

本轮外部输入位于 data。读取其中的 issue ID，通过对应 MCP 查询最新状态，
再按本文流程处理。缺少业务信息时说明缺少什么，不凭空补全。
```

示例 secret 仅为占位符。默认使用 32 字节安全随机 secret，也可自行设置。secret 明文保存在 frontmatter，详情始终可查看、复制和修改；普通读取、保存、重启和更名不重新生成。修改后，接收端立即按最新定义校验。secret 不进入 Run 输入、执行快照、提示词、普通日志或错误回显；MCP 的定义响应省略 secret，界面仍通过现有管理 HTTP 详情读取。

- `enabled`：控制所有新执行入口。停用不自动取消已接收的排队和正在执行的 Run。
- `schedule_enabled`：只暂停或启用定时，不影响手动和外部调用。
- `schedule`：可为 null/省略；有定时时继续支持 once、interval、hourly、daily、weekly、monthly 与 work_hours。
- `external_enabled`：只控制外部调用。启用时必须有非空 secret；旧文件首次通过管理接口启用时，缺失的 secret 会生成并持久化。
- 停止 Run：只取消选中的 Run，不修改 Action 开关。已接收的队列使用接收时的任务快照，之后的编辑不覆盖其指令和输入。

生效时段仅约束定时入口。同 Action 手动和外部调用按接收顺序排队；同一时刻最多运行一个。定时仍沿用原有重叠跳过、错过周期合并规则，不为每个错过周期堆积队列。

编辑页顶部控制 Action 整体启停。“执行入口”中的“定时执行”和“HTTP Trigger”独立开启，开启后才显示对应配置。开启 HTTP Trigger 时，如果 Secret 为空则立即生成；已有值保持不变。Secret 输入框右侧可复制或重新生成，修改保存后生效。关闭开关保留编辑中的配置。生效时段继续支持多段；执行客户端在默认折叠的“高级设置”中，位于模型之前。“调用示例”提供可复制的完整 curl。

## 外部调用

独立端口只提供：

```http
POST /actions/<action-id>/trigger
Content-Type: application/json
```

```json
{
  "secret": "该 Action 当前的 secret",
  "data": { "issue_id": "DEMO-1" }
}
```

`secret` 必须为非空字符串，最多 1024 个字符；`data` 字段必须存在，可为对象、数组、字符串、数字、布尔值或 null。除此之外不接受额外顶层字段。Rillo 不解析 data 的业务字段，不映射参数，不根据内容或哈希去重。每次有效请求建立独立 Run。鉴权使用固定长度 SHA-256 摘要的 timing-safe 比较。

```sh
curl -X POST 'http://127.0.0.1:43128/actions/ACTION_ID/trigger' \
  -H 'Content-Type: application/json' \
  --data '{"secret":"ACTION_SECRET","data":{"issue_id":"DEMO-1"}}'
```

可靠落盘后返回 `202`：

```json
{ "accepted": true, "run_id": "RUN_ID", "status": "queued" }
```

这是接收凭据，不是执行成功。缺失/错误密钥返回 401；格式错误 400；类型错误 415；体积超限 413；未知或关闭的入口 404；限流/队列满 429；存储或服务不可用 503。失败响应不回显请求正文或 secret，不等待 Agent 完成。

默认限制：256 KiB 请求体、整个监听端口每分钟 120 次请求、64 个连接、15 秒请求超时、全局最多 1000 个排队 Run。无效请求在创建 Run 前拒绝。不保留包含 secret 的原始请求体。

## 监听与部署

同一个 daemon 提供两个监听端口。管理端口继续服务页面、会话、文件和管理 API；外部端口仅匹配上述 POST，不能访问管理、会话或文件接口。不新增 Host/Origin 访问拦截。

在 `~/.config/rillo/config.json` 中配置，重启 daemon 生效：

```json
{
  "action_trigger_host": "127.0.0.1",
  "action_trigger_port": 43128,
  "action_trigger_public_url": "https://actions.example.com"
}
```

这些字段合并到现有配置，不能用该片段覆盖整个 config。默认仅监听本机；host 可为 127.0.0.1、0.0.0.0、::1 或 ::。端口必须与管理端口不同。公开 URL 仅用于生成界面调用地址，接受 HTTP(S) origin；不创建域名、证书或隧道。未配置时展示本机地址。对应环境变量为 `RILLO_ACTION_TRIGGER_HOST`、`RILLO_ACTION_TRIGGER_PORT`、`RILLO_ACTION_TRIGGER_PUBLIC_URL`。

典型外部链路：第三方 → 可选 `adnanh/webhook` 与转发脚本 → 可选 frp → 外部触发端口。第三方验签、筛选、业务去重、包装 `{secret,data}` 和选择 Action 都由外部系统负责。frp 与 adnanh/webhook 不是内置依赖，本功能不会安装或启动它们。本机离线时无法接收请求，不提供云端补投。

## 输入、Session 与恢复

Run 的 `input_json` 单独保存本轮 data，固定 Markdown 不随调用改写。执行提示明确区分任务正文与本轮外部数据；data 从不作为 workspace、Agent、模型、权限、命令或其他执行配置。手动和定时的 data 默认为 null。运行列表只读摘要，不批量加载输入；Run 详情可查看来源与完整输入，继续使用原来的状态、结果、日志、文件变化和原生 Session 入口。

排队 Run 真正启动前，才根据前一轮的实际 Session 选择 new/reuse/auto、继承次数和 compact 配置，避免连续请求提前选中旧 Session。本轮输入始终再次明确提供。

v5 的未启动队列在重启后继续；开始调用 Runtime 前已持久化为 running，重启将这类结果不明的记录标记 interrupted，不自动重跑。优雅停机保留尚未启动的队列。目录占用与未知进程仍由已有资源协调器核对；恢复不会绕过互斥或执行权限。

## 兼容与迁移

- 现有 `rillo/schedule` 和已支持的旧 Recorder type 自动识别，不因扫描或启动改写文件。
- 旧 `enabled` 是定时开关，读取时映射为 `schedule_enabled`；整体 Action 默认启用，保留原来暂停定时后仍可手动执行的能力。旧任务外部调用默认关闭、secret 为 null。
- 显式管理保存写回 `rillo/action`，保留 ID、文件路径、正文与原执行配置。重命名不改 ID 或调用地址。
- SQLite v4 原子迁移到 v5，保留 Run ID、快照、结果、Session 与日志引用，输入默认为 null。v4 的 queued 在旧实现中可能已经进入启动过程，因此升级时保守标记 interrupted，不盲目重放；新 v5 队列有明确的启动边界。旧运行中记录仍按恢复规则中断。
- 保留原数据库路径、scheduled_runs 表和内部 schedule_id 字段。外部管理入口使用 `/api/v1/actions`；旧 `/api/v1/schedules` 路径映射到同一实现。JSON 中保留 `jobs/job` 包装，Run 同时提供 `action_id` 和兼容字段。

## 管理 API 与 MCP

管理 HTTP 复用现有接口形状：

| 方法与路径 | 行为 |
| --- | --- |
| GET/POST `/api/v1/actions` | 列出/创建 Action，创建无需 cadence |
| GET/PATCH/DELETE `/api/v1/actions/:id` | 详情/修改/移入回收目录；修改和删除要求 expected_etag |
| POST `/api/v1/actions/:id/pause` 或 `/resume` | 整体停用/启用，不停止已接收执行 |
| POST `/api/v1/actions/:id/run` | 手动运行，data=null；重试沿用 idempotency_key |
| GET `/api/v1/actions/:id/runs` | 运行历史与来源 |
| GET `/api/v1/runs/:id` | 状态、结果与 data，继续复用日志/Session/停止等子接口 |

PATCH body 为 `{expected_etag,patch}`；只暂停定时可使用 `patch:{schedule_enabled:false}`。列表不返回 secret；本地管理详情返回 secret。MCP 提供 `action_list/get/create/update/delete/pause/resume/run/runs`，使用 action_id。原 `schedule_*` 工具保留，直接复用同一实现，旧工具的标识字段仍为 schedule_id。MCP 不返回 secret；通过本地界面查看与复制。

没有新增真实业务任务，也没有切换、停用或重写现有 Linear Bug 自动化。业务接入应在临时任务验证后另行迁移。
