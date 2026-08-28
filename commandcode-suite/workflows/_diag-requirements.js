'use strict'
/** Diagnostic: run product-analyst with the exact requirements schema and print raw output. */
const { runAgent, runCmdc, loadAgent } = require('./_runner')

const CRITERIA_SCHEMA = {
  type: 'object',
  required: ['criteria', 'assumptions', 'openQuestions', 'surfaces'],
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'text'],
        properties: { id: { type: 'string' }, text: { type: 'string' } },
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    surfaces: { type: 'array', items: { type: 'string', enum: ['backend', 'frontend', 'data'] } },
  },
}

async function main() {
  const agentBody = loadAgent('product-analyst')
  const prompt = [
    'You are operating as the following agent definition. Follow its system prompt exactly; its procedures, evidence standards, and stop conditions bind you.',
    '',
    '===== AGENT DEFINITION =====',
    agentBody,
    '===== END AGENT DEFINITION =====',
    '',
    '===== TASK =====',
    `Convert this initiative into implementation-ready requirements: Build a Windows desktop screen-capture and recording application (a Snagit replacement).

Produce numbered, stable acceptance-criterion IDs — every downstream agent in this workflow traces against them, so an unstable ID breaks the whole run. Record assumptions as numbered/traceable/risk-rated per your §4. Do not invent a success metric that wasn't given; label any proposal as proposed-not-confirmed.

Also classify which implementation surfaces this genuinely touches (backend / frontend / data) so the build phase only spawns the specialists actually needed.`,
    '',
    '===== OUTPUT CONTRACT =====',
    'Respond with a SINGLE JSON object and NOTHING ELSE — no prose, no markdown fences, no trailing commentary, no keys outside the schema.',
    'The JSON object is the TOP-LEVEL envelope described by the schema. If the schema has a `required` field like "criteria", that key must be present at the TOP LEVEL of your response and its value must be an ARRAY of items, not a single item.',
    'The complete schema:',
    JSON.stringify(CRITERIA_SCHEMA, null, 2),
  ].join('\n')

  const res = await runCmdc(['-p', prompt, '--permission-mode', 'auto-accept', '--skip-onboarding', '--max-turns', '200'])
  console.log('=== EXIT CODE ===', res.code)
  console.log('=== RAW STDOUT (first 3000 chars) ===')
  console.log(res.out.slice(0, 3000))
  console.log('=== RAW STDOUT (last 1500 chars) ===')
  console.log(res.out.slice(-1500))
  console.log('=== STDERR (first 1000 chars) ===')
  console.log(res.err.slice(0, 1000))
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
