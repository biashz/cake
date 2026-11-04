import { describe, expect, it } from 'vitest';
import { detectDanger } from '../src/permissions/danger.js';

describe('detectDanger', () => {
  it('flags destructive shell commands', () => {
    expect(detectDanger('bash', 'rm -rf /')).toMatch(/recursive force delete/);
    expect(detectDanger('bash', 'rm -fr node_modules')).toMatch(/recursive force delete/);
    expect(detectDanger('bash', 'git push origin main --force')).toBe('force push');
    expect(detectDanger('bash', 'git reset --hard HEAD~3')).toBe('hard reset');
    expect(detectDanger('bash', 'shutdown -h now')).toBe('system shutdown');
    expect(detectDanger('bash', 'DROP TABLE users')).toBe('database drop');
  });

  it('leaves ordinary commands alone', () => {
    expect(detectDanger('bash', 'npm test')).toBeUndefined();
    expect(detectDanger('bash', 'rm file.txt')).toBeUndefined();
    expect(detectDanger('bash', 'git push origin main')).toBeUndefined();
    expect(detectDanger('bash', 'git status')).toBeUndefined();
  });

  it('flags dangerous git tool targets', () => {
    expect(detectDanger('git', 'push origin main --force')).toBe('force push');
    expect(detectDanger('git', 'reset --hard')).toBe('hard reset');
    expect(detectDanger('git', 'status')).toBeUndefined();
  });

  it('flags credential files for file tools', () => {
    expect(detectDanger('read', '.env')).toBe('sensitive credential file');
    expect(detectDanger('write', 'config/prod.env')).toBeUndefined();
    expect(detectDanger('write', '.env.local')).toBe('sensitive credential file');
    expect(detectDanger('edit', 'keys/server.pem')).toBe('sensitive credential file');
    expect(detectDanger('read', 'src/index.ts')).toBeUndefined();
  });

  it('does not treat credential-looking text in shell commands as file access', () => {
    expect(detectDanger('bash', 'echo .env')).toBeUndefined();
  });
});
