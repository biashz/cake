import { describe, expect, it } from 'vitest';
import { CLI_COMMANDS, commandHelp } from '../src/cli/commands.js';
import { helpText } from '../src/cli/help.js';
import {
  MODE_BEHAVIOR,
  MODE_NAMES,
  PERMISSION_MODES,
  parsePermissionMode,
} from '../src/permissions/modes.js';

/**
 * `cake --help` is the second screen that advertises what cake answers, and it
 * used to be typed out by hand beside the list the interactive session prints.
 * Both now come from one table, so a command can only be missing from the
 * screen if it is missing from the program.
 */

/** The names on the one-line command list. */
function advertisedCommands(text: string): string[] {
  const line = text.split('\n').find((row) => row.includes('Interactive commands')) ?? '';
  return [...line.matchAll(/\/([a-z]+)/g)].map((match) => match[1] as string);
}

describe('cake --help', () => {
  it('lists the commands the interactive session answers, and no others', () => {
    expect(advertisedCommands(helpText()).sort()).toEqual(
      CLI_COMMANDS.map((command) => command.name).sort(),
    );
  });

  it('says what each mode the flag accepts does', () => {
    const text = helpText();
    expect(text).toContain(`--permission-mode <m> ${MODE_NAMES}`);
    for (const mode of PERMISSION_MODES) expect(text).toContain(MODE_BEHAVIOR[mode]);
  });

  it('points at /mode, and says the switch does not survive the run', () => {
    const text = helpText();
    expect(text).toContain('/mode <name>');
    expect(text).toContain('It is not remembered');
  });

  it('lists the same commands the session lists itself', () => {
    const inSession = commandHelp()
      .split('\n')
      .map((row) => (row.trim().split(/\s+/)[0] ?? '').replace(/^\//, ''));
    expect(inSession.sort()).toEqual(advertisedCommands(helpText()).sort());
  });

  it('accepts the mode names it advertises, and nothing shaped like one', () => {
    for (const mode of PERMISSION_MODES) expect(parsePermissionMode(mode)).toBe(mode);
    // The names are spelled one way; a mode typed with a capital or half a word
    // is the typo /mode refuses, not a mode the engine quietly maps.
    expect(parsePermissionMode('Plan')).toBeUndefined();
    expect(parsePermissionMode('acc')).toBeUndefined();
    expect(parsePermissionMode('everything')).toBeUndefined();
    expect(MODE_NAMES).toBe('plan | default | acceptEdits | yolo');
  });
});
