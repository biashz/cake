import { describe, expect, it } from 'vitest';
import { rulesView } from '../src/desktop/rules-view.js';
import type { SettingsLayer } from '../src/permissions/settings.js';

const files = { global: '/home/u/.cake/settings.json', project: '/repo/.cake/settings.json' };

function layer(scope: 'global' | 'project', allow: string[], deny: string[]): SettingsLayer {
  return { scope, file: files[scope], permissions: { allow, deny } };
}

describe('rulesView', () => {
  it('lists workspace rows before global ones, each in file order', () => {
    const view = rulesView(
      [
        layer('global', ['read', 'web_search'], []),
        layer('project', ['bash(npm test*)'], ['bash(rm *)', 'edit(.git/*)']),
      ],
      files,
    );

    expect(view.allow.map((row) => [row.scope, row.rule])).toEqual([
      ['project', 'bash(npm test*)'],
      ['global', 'read'],
      ['global', 'web_search'],
    ]);
    expect(view.deny.map((row) => row.rule)).toEqual(['bash(rm *)', 'edit(.git/*)']);
  });

  it('names the allow rules a matching deny cancels', () => {
    const view = rulesView(
      [layer('global', ['bash(npm test*)'], []), layer('project', ['read'], ['read'])],
      files,
    );

    expect(view.conflicts).toEqual(['read']);
  });

  it('reports no rules and no project file until a workspace is open', () => {
    const view = rulesView([layer('global', ['read'], [])], {
      global: files.global,
      project: null,
    });

    expect(view.allow).toEqual([{ rule: 'read', scope: 'global' }]);
    expect(view.deny).toEqual([]);
    expect(view.conflicts).toEqual([]);
    expect(view.files.project).toBeNull();
  });
});
