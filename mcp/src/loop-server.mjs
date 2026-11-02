import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export function createLoopToolServer({ env = process.env, fetchImpl = fetch } = {}) {
  const server = new McpServer({ name: 'rillo_loop', version: '1.0.0' }, {
    instructions: 'Tools are scoped to this execution, task input version and role. Submit one final result before ending. Plain mentions do not dispatch work. Do not change credentials or call another task.',
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
  server.registerTool('read_context', { description: 'Read the task snapshot or page full room history, results and sourced memories. before is the next_before cursor, query is a literal search.', inputSchema: {section:z.enum(['snapshot','messages','memories','results','artifact','attachment']).default('snapshot'),before:z.number().int().positive().optional(),limit:z.number().int().min(1).max(50).default(20),query:z.string().max(200).optional(),source_message_id:z.string().optional(),attachment_index:z.number().int().min(0).max(7).optional(),source_run_id:z.string().optional(),reference:z.string().max(2048).optional(),offset:z.number().int().nonnegative().optional()} }, input => call('read_context',input))
  server.registerTool('remember',{description:'Persist a shared decision (leader only) or summary with exact source message/run IDs. Does not change permissions or delivery state.',inputSchema:{kind:z.enum(['decision','summary']),text:z.string().min(1).max(12000),sources:z.array(z.string().min(1)).min(1).max(32),request_key:z.string().min(1).max(128)}},input=>call('remember',input))
  server.registerTool('submit_result', { description: 'Submit one immutable phase result. CLI exit is tracked separately.', inputSchema: {
    summary: z.string().min(1).max(12000), verdict: z.enum(['complete', 'pass', 'fail']).default('complete'),
    artifacts: z.array(z.string().max(2048)).max(32).default([]),
  } }, input => call('submit_result', input))
  server.registerTool('request_action', { description: 'Leader only: deliver, wait, or prepare_projects named explicitly in a user message (workspaces and source_message_id). Do this before dispatching workers; execution_mode selects isolated (new branch, optional branch as start ref), existing_branch (continue a named local branch, reuse its checkout) or explicit in_place (use current directory without switching). branch must appear in the user message. When execution_mode is omitted, branch selects existing_branch; without branch it defaults to isolated. Legacy fixed tasks may advance.', inputSchema: {
    action: z.enum(['advance', 'wait', 'deliver','prepare_projects','cancel_assignment']), inbox_id:z.string().optional(),workspaces:z.array(z.string().min(1).max(4096)).min(1).max(8).optional(),source_message_id:z.string().optional(),execution_mode:z.enum(['isolated','existing_branch','in_place']).optional(),branch:z.string().min(1).max(255).optional(),reason: z.string().min(1).max(2000),
  } }, input => call('request_action', input))
  server.registerTool('send_message', { description: 'Post in the room and @ exact teammate IDs. Delegate concrete work, request verification, reply to the actual requester, or announce without waking anyone.', inputSchema: {
    text: z.string().min(1).max(20000), mentions: z.array(z.string().min(1)).max(6).default([]),
    intent: z.enum(['delegate','verify','reply','announce']), depends_on:z.array(z.string().min(1)).max(12).default([]), write_access: z.boolean().default(false),
    request_key: z.string().min(1).max(128),
  } }, input => call('send_message', input))
  server.registerTool('report_progress', { description: 'Record bounded progress without changing task completion.', inputSchema: {
    text: z.string().min(1).max(2000),
  } }, input => call('report_progress', input))
  return server
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await createLoopToolServer().connect(new StdioServerTransport())
}
