import { MODE_NAMES } from '../permissions/modes.js';

/** One interactive command: what you type, what it takes, and what it does. */
export interface CliCommand {
  /** The word after the slash. */
  name: string;
  /** The argument placeholder, when the command takes one. */
  args?: string;
  summary: string;
}

/**
 * The commands the interactive session answers. Both help screens are written
 * from this list, so the one that advertises a command and the one that dispatches
 * it cannot disagree.
 */
export const CLI_COMMANDS: readonly CliCommand[] = [
  { name: 'help', summary: 'show this list' },
  { name: 'clear', summary: 'start a new session' },
  { name: 'fork', summary: 'branch this conversation into a new session' },
  { name: 'export', args: '[file]', summary: 'write the transcript as Markdown' },
  {
    name: 'revert',
    args: '[n]',
    summary: 'undo the file changes of turn n (newest if omitted); "list" shows them',
  },
  { name: 'model', args: '<id>', summary: 'switch model id (same provider)' },
  { name: 'mode', args: '<name>', summary: `switch permission mode — ${MODE_NAMES}` },
  { name: 'cost', summary: 'session token and cost totals' },
  { name: 'exit', summary: 'quit (or Ctrl+C; /quit is the same)' },
];

/** Where every description starts, whatever the command line before it looks like. */
const DESCRIPTION_COLUMN = 17;

function usage(command: CliCommand): string {
  return command.args ? `/${command.name} ${command.args}` : `/${command.name}`;
}

/** The `/help` body: one row per command. */
export function commandHelp(): string {
  return CLI_COMMANDS.map((command) =>
    `${usage(command).padEnd(DESCRIPTION_COLUMN)}${command.summary}`.trimEnd(),
  ).join('\n');
}

/** The names, for the one-line list `cake --help` prints. */
export function commandNames(): string {
  return CLI_COMMANDS.map((command) => `/${command.name}`).join('  ');
}
