import { MODE_NAMES, modeHelp } from '../permissions/modes.js';
import { commandNames } from './commands.js';

/**
 * What `cake --help` prints. Kept out of the entry point so a test can read the
 * same screen a person does.
 */
export function helpText(): string {
  return [
    'cake — a TypeScript CLI programming agent',
    '',
    'Usage:',
    '  cake                      Start interactive chat',
    '  cake "<prompt>"           Run a single prompt (headless)',
    '  cake -p "<prompt>"        Same as above (explicit print mode)',
    '',
    'Options:',
    '  -p, --print               Headless: stream the reply and exit',
    '  -y, --yes                 Auto-approve every tool call (yolo mode)',
    `      --permission-mode <m> ${MODE_NAMES}`,
    '      --provider <id>       Provider: deepseek | anthropic | openai',
    '  -m, --model <id>          Model id (overrides config/default)',
    '  -c, --continue            Resume the most recent session in this workspace',
    '      --resume <id>         Resume a session by id',
    '      --revert [n]          Undo the file changes of recorded turn n, then exit',
    '      --doctor              Diagnose Node, providers, config, settings, MCP, sessions, index',
    '  -h, --help                Show this help',
    '  -v, --version             Print version',
    '',
    'Input:',
    '  @path/to/file             Attach a file to the prompt',
    '  @codebase                 Retrieve relevant code chunks (semantic search)',
    `  ${commandNames()}    Interactive commands`,
    '',
    'Project context:',
    '  AGENTS.md files from the workspace root upward are loaded into the system prompt.',
    '  Sessions persist in .cake/sessions/cake.db (node:sqlite).',
    '  /export writes the transcript to .cake/exports/<workspace>-<id>.md unless given a path.',
    '  Files a turn changes are archived in .cake/checkpoints (last 50 turns) for /revert.',
    '',
    'MCP:',
    '  ~/.cake/mcp.json and .cake/mcp.json define "mcpServers" (stdio or http).',
    '  Tools appear as mcp__<server>__<tool>; read-only server hints map to read access.',
    '',
    'Permission modes:',
    modeHelp(),
    '  Switch in the interactive session with /mode <name>. It is not remembered:',
    '  the next start reads --permission-mode (or -y) again.',
    '',
    'Environment:',
    '  DEEPSEEK_API_KEY | ANTHROPIC_API_KEY | OPENAI_API_KEY   API keys',
    '  CAKE_PROVIDER, CAKE_MODEL            Defaults (provider defaults to deepseek)',
    '',
    'Rules:',
    '  .cake/settings.json  { "permissions": { "allow": ["bash(npm test*)"], "deny": [...] } }',
    '  Rule syntax: tool or tool(pattern); * and ? are wildcards; deny wins over allow.',
    '',
  ].join('\n');
}
