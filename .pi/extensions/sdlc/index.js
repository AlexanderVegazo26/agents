/**
 * The sdlc-suite pi extension.
 *
 * Registers two tools that close the two gaps between the suite (written for
 * Claude Code) and the pi harness — see .pi/extensions/sdlc/lib.js for the
 * full design and .pi/extensions/sdlc/README.md for the operator notes:
 *
 *   agent     one sub-agent dispatch (Claude Code's Agent()/Task): a separate
 *             pi session running the named role file from sdlc-suite/agents/
 *   workflow  one Workflow-tool run: sdlc-suite/workflows/*.js in a node:vm
 *             sandbox that reproduces Claude Code's allowlist, with agent()
 *             backed by those same separate pi sessions
 *
 * Hand-maintained: the tree generator (sdlc-suite/tools/generate_trees.py)
 * never writes or removes anything under .pi/extensions/.
 */

import * as sdlc from './lib.js';

const AGENT_GUIDELINES = [
  'Dispatch a suite sub-agent with `agent`: `name` is an agent from the sdlc-suite/agents/ directory (e.g. "code-reviewer", "qa-runner"; the "sdlc-suite:" prefix is accepted), `task` is the complete brief.',
  'Each `agent` call runs a separate pi session whose instructions are that agent\'s role file. The sub-agent cannot see this conversation — the brief must stand alone.',
  'One `agent` call is one sub-agent run. Do not split a single role\'s work across parallel `agent` calls, and do not use `agent` for work the current session can do itself.',
  'When a result comes back "no result", the dispatch genuinely failed; say so. Never invent the sub-agent\'s output.',
];

const WORKFLOW_GUIDELINES = [
  'Run a suite pipeline with `workflow`: pass the exact `scriptPath` and the `args` OBJECT from the command template — never a bare string.',
  'The `workflow` tool executes the script in the suite sandbox and returns the pipeline\'s final result. Report that result — do not re-derive or second-guess its classification, and do not add confidence the pipeline did not.',
  'A workflow run reaches its run recorder, policy loader and learnings through bridge agents; do not create, edit or delete anything under .claude/runs/ yourself.',
  'If the tool reports failure, relay the failure. Do not improvise a substitute run and do not report a result the pipeline did not produce.',
];

function safeJson(value) {
  try {
    return JSON.stringify(value, (k, v) => (typeof v === 'function' ? undefined : v), 2);
  } catch {
    return String(value);
  }
}

function tail(lines, n = 50) {
  return lines.slice(-n);
}

export default function (pi) {
  pi.registerTool({
    name: 'agent',
    label: 'SDLC sub-agent',
    description:
      'Run one sdlc-suite sub-agent (a role file from sdlc-suite/agents/) in its own pi session. ' +
      'The sub-agent cannot see this conversation: `task` must be a complete, self-contained brief. ' +
      'Returns the sub-agent\'s final output, or an explanation of why no result came back.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Agent name from the sdlc-suite/agents/ directory, e.g. "code-reviewer" or "qa-runner". The "sdlc-suite:" prefix is also accepted.',
        },
        task: {
          type: 'string',
          description: 'The complete, self-contained brief for the sub-agent.',
        },
      },
      required: ['name', 'task'],
      additionalProperties: false,
    },
    promptGuidelines: AGENT_GUIDELINES,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const anchor = ctx && ctx.cwd ? ctx.cwd : process.cwd();
      const log = (line) => {
        try { if (typeof onUpdate === 'function') onUpdate({ content: [{ type: 'text', text: line }] }); } catch { /* best effort */ }
      };
      const value = await sdlc.runAgent({
        anchor,
        prompt: params.task,
        opts: { label: params.name, agentType: params.name },
        log,
        timeoutMs: sdlc.agentTimeoutMs(),
      });
      if (value === null) {
        return {
          content: [{ type: 'text', text: `agent "${params.name}" returned no result — the reason is in the progress lines above. Do not treat the task as done and do not invent its output.` }],
          details: { name: params.name, result: null },
        };
      }
      return {
        content: [{ type: 'text', text: typeof value === 'string' ? value : safeJson(value) }],
        details: { name: params.name },
      };
    },
  });

  pi.registerTool({
    name: 'workflow',
    label: 'SDLC workflow',
    description:
      'Run an sdlc-suite workflow script (sdlc-suite/workflows/*.js) in the suite sandbox, which reproduces ' +
      'Claude Code\'s Workflow tool: a node:vm context with an allowlist (agent, parallel, pipeline, workflow, ' +
      'phase, log, args, budget, setTimeout, clearTimeout, console; no require, process or fs) and agent() backed ' +
      'by separate pi sessions. Returns the pipeline\'s final result object as JSON.',
    parameters: {
      type: 'object',
      properties: {
        scriptPath: {
          type: 'string',
          description: 'Path to the workflow script, e.g. "sdlc-suite/workflows/release-readiness.js".',
        },
        args: {
          type: 'object',
          description: 'The workflow arguments object exactly as the command states it (e.g. { release, runtimeDir, policyDefault }). Always an object, never a string.',
        },
      },
      required: ['scriptPath'],
      additionalProperties: false,
    },
    promptGuidelines: WORKFLOW_GUIDELINES,
    executionMode: 'sequential',
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const anchor = ctx && ctx.cwd ? ctx.cwd : process.cwd();
      const logs = [];
      const log = (line) => {
        logs.push(line);
        try { if (typeof onUpdate === 'function') onUpdate({ content: [{ type: 'text', text: line }] }); } catch { /* best effort */ }
      };
      const out = await sdlc.runWorkflow({
        anchor,
        scriptPath: params.scriptPath,
        args: params.args ?? {},
        log,
        agent: async ({ prompt, opts }) => sdlc.runAgent({
          anchor,
          prompt,
          opts,
          log,
          timeoutMs: sdlc.agentTimeoutMs(),
        }),
        onUpdate,
      });
      if (!out.ok) {
        return {
          content: [{ type: 'text', text: `workflow failed: ${out.error}` }],
          details: { scriptPath: params.scriptPath, status: 'failed', logs: tail(logs) },
        };
      }
      return {
        content: [{ type: 'text', text: `workflow "${(out.meta && out.meta.name) || params.scriptPath}" finished.\nRESULT:\n${safeJson(out.result)}` }],
        details: { scriptPath: params.scriptPath, status: 'done', meta: out.meta, logs: tail(logs) },
      };
    },
  });
}
