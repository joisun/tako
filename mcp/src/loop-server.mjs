import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export function createLoopToolServer({ env = process.env, fetchImpl = fetch } = {}) {
  const server = new McpServer({ name: 'rillo_loop', version: '1.0.0' }, {
    instructions: 'Tools are scoped to this execution, task input version and role. Teams preserve the public native answer; submit_result is optional for structured reporting. Legacy phase tasks still require it as specified by their prompt. Use ask for a new question, linked reply for its answer and announce for information only. Plain mentions do not dispatch work. Progress is internal; accepted reports need no completion ping. Do not change credentials or call another task.',
  })
  async function call(action, input = {}) {
    const base = new URL(env.RILLO_LOOP_URL)
    if (!['127.0.0.1', '[::1]'].includes(base.hostname) || base.protocol !== 'http:') throw new Error('Run tools require a loopback service URL')
    const response = await fetchImpl(new URL(`/api/v1/loop-runs/${encodeURIComponent(env.RILLO_LOOP_RUN)}/tools/${action}`, base), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RILLO_LOOP_TOKEN}` },
      body: JSON.stringify(input), signal: AbortSignal.timeout(10000),
    })
    const value = await response.json()
    if (!response.ok) return { isError: true, content: [{ type: 'text', text: JSON.stringify(value.error) }] }
    return { content: [{ type: 'text', text: JSON.stringify(value) }] }
  }
  server.registerTool('read_context', { description: 'Read the task snapshot or page room history, results and sourced memories. section=results with source_run_id returns non-Hook public answers and formal report references. section=reports with report_id and optional version/offset reads the full versioned report. section=evidence with reference reads a file within the task or prepared project, returning its actual read time, content hash and evidence ID; use these IDs in findings. section=progress returns source-backed execution outcomes, pending assignments and progress reports. section=memories with source_memory_id reads a full saved memory, including superseded history. before is the next_before cursor, query is a literal body-text search, not an ID lookup.', inputSchema: {section:z.enum(['snapshot','messages','memories','results','reports','evidence','progress','artifact','attachment']).default('snapshot'),before:z.number().int().positive().optional(),limit:z.number().int().min(1).max(50).default(20),query:z.string().max(200).optional(),source_memory_id:z.string().max(128).optional(),source_message_id:z.string().optional(),attachment_index:z.number().int().min(0).max(7).optional(),source_run_id:z.string().optional(),report_id:z.string().max(128).optional(),version:z.number().int().positive().optional(),reference:z.string().max(2048).optional(),offset:z.number().int().nonnegative().optional()} }, input => call('read_context',input))
  server.registerTool('remember',{description:'Persist a shared decision (leader only) or summary with exact source message/run IDs. Optional supersedes identifies outdated same-kind memories in this team; originals remain readable. Does not change permissions or delivery state.',inputSchema:{kind:z.enum(['decision','summary']),text:z.string().min(1).max(12000),sources:z.array(z.string().min(1)).min(1).max(32),supersedes:z.array(z.string().min(1).max(128)).max(32).optional(),request_key:z.string().min(1).max(128)}},input=>call('remember',input))
  server.registerTool('submit_result', { description: 'Optional structured Teams report; legacy phase tasks require it. Handed once to the actual requester after exit, with execution status tracked separately. answered_message_ids explicitly closes the cited questions. Corrections update the same report version. Hook acknowledgements without new evidence/findings do not overwrite it; a substantive correction from an automatic continuation must include correction_reason. notification=after_exit with recipients is a planned handoff, not delivery confirmation; notification=none still preserves the visible report. Do not repeat it in a chat acknowledgement or a second final summary. A waiting turn does not require a completion report.', inputSchema: {
    correction_reason:z.string().min(1).max(2000).optional(),
    summary: z.string().min(1).max(12000), verdict: z.enum(['complete', 'pass', 'fail']).default('complete'),
    artifacts: z.array(z.string().max(2048)).max(32).default([]),
    answered_message_ids:z.array(z.string().min(1).max(128)).max(32).optional(),evidence_ids:z.array(z.string().min(1).max(128)).max(64).optional(),
    findings:z.array(z.object({id:z.string().min(1).max(128),text:z.string().min(1).max(2000),evidence_ids:z.array(z.string().min(1).max(128)).max(64)})).max(32).optional(),
  } }, input => call('submit_result', input))
  server.registerTool('request_action', { description: 'Use reconcile_delivery with inbox_id to check an uncertain native receipt (recipient or Leader); an absent marker remains unknown and is not automatically resent. Leader actions: deliver, wait, or prepare_projects using workspaces resolved from the task and available context; no verbatim user-path message or repeated confirmation is required. Prepare a project before assigning work in it; independent members may continue working; execution_mode selects isolated (new branch, optional branch as start ref), existing_branch (continue a named local branch, reuse its checkout) or explicit in_place (use current directory without switching). When execution_mode is omitted, branch selects existing_branch; without branch it defaults to isolated. Existing task bindings can be updated by explicitly selecting another branch or execution mode. Branch/worktree renames are refreshed from Git before subsequent executions. Legacy fixed tasks may advance.', inputSchema: {
    action: z.enum(['advance', 'wait', 'deliver','prepare_projects','cancel_assignment','reconcile_delivery']), inbox_id:z.string().optional(),workspaces:z.array(z.string().min(1).max(4096)).min(1).max(8).optional(),execution_mode:z.enum(['isolated','existing_branch','in_place']).optional(),branch:z.string().min(1).max(255).optional(),reason: z.string().min(1).max(2000),
  } }, input => call('request_action', input))
  server.registerTool('send_message', { description: 'Post in the room and @ exact teammate IDs. Use delegate/verify for bounded work with an owner and expected outcome. Use ask for a question requiring an answer, reply with reply_to_message_id or assignment_id to close the original question/work, and announce for information requiring no action even when multiple teammates are mentioned. notification=context_only means shared context with no wakeup, not native silent injection; member_inbox means a durable recipient entry, not that execution started. A delivery receipt never proves that a question is answered. Identical unfinished assignments from the same requester to the same teammate reuse their existing inbox/run and return reused=true instead of dispatching again.', inputSchema: {
    text: z.string().min(1).max(20000), mentions: z.array(z.string().min(1)).max(6).default([]),
    intent: z.enum(['delegate','verify','ask','reply','announce']), depends_on:z.array(z.string().min(1)).max(12).default([]), write_access: z.boolean().default(false).describe('Implementation scheduling hint, not a filesystem permission grant. Codex Teams executions use full access; respect explicit user constraints.'),
    request_key: z.string().min(1).max(128),
    resource_scope:z.object({access:z.enum(['none','read','write']),projects:z.array(z.number().int().min(1).max(8)).max(8)}).optional().describe('Actual resource needs for this work. Project numbers refer to prepared projects. none is coordination without project access; read records audit evidence while allowing edits; write reserves selected projects. This does not expand runtime permissions.'),
    expected_output:z.string().min(1).max(2000).optional(),acceptance:z.string().min(1).max(2000).optional(),
    reply_to_message_id:z.string().min(1).max(128).optional(),assignment_id:z.string().min(1).max(128).optional(),answered_message_ids:z.array(z.string().min(1).max(128)).max(32).optional(),
  } }, input => call('send_message', input))
  server.registerTool('report_progress', { description: 'Record internal progress without posting a chat message, waking a teammate or changing task completion. Returns notification=internal_only. Use send_message for a concrete question, new finding or blocker, not another progress acknowledgement.', inputSchema: {
    text: z.string().min(1).max(2000),
  } }, input => call('report_progress', input))
  return server
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await createLoopToolServer().connect(new StdioServerTransport())
}
