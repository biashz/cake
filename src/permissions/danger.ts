interface DangerPattern {
  re: RegExp;
  reason: string;
}

const SHELL_PATTERNS: DangerPattern[] = [
  { re: /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b/, reason: 'recursive force delete (rm -rf)' },
  {
    re: /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|-f)\b/,
    reason: 'force push',
  },
  { re: /\bgit\s+reset\s+--hard\b/, reason: 'hard reset' },
  { re: /\bgit\s+clean\s+-[a-z]*f/, reason: 'git clean -f' },
  { re: /\bmkfs(?:\.\w+)?\b/, reason: 'filesystem format' },
  { re: /\bdd\b[^\n]*\bof=\/dev\//, reason: 'raw device write' },
  { re: /\b(?:shutdown|reboot|poweroff|halt)\b/, reason: 'system shutdown' },
  { re: /\bchmod\s+-R\s+777\s+\//, reason: 'world-writable root' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  { re: /\bdrop\s+(?:table|database)\b/i, reason: 'database drop' },
  { re: /\bformat\s+[a-z]:/i, reason: 'disk format' },
  {
    re: /\b(?:rd|rmdir)\s+\/s\s+\/q\s+[a-z]:\\/i,
    reason: 'recursive directory delete',
  },
];

const SENSITIVE_FILE =
  /(^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.netrc|\.git-credentials|id_(?:rsa|ed25519|ecdsa)|[^/]+\.(?:pem|key|p12|pfx)|credentials(?:\.[^/]*)?)$/i;

const FILE_TOOLS = new Set(['read', 'write', 'edit']);

/**
 * Detect commands and file targets that warrant a forced confirmation even when
 * the active mode would otherwise auto-approve them.
 */
export function detectDanger(toolName: string, target: string): string | undefined {
  const normalized = target.replace(/\\/g, '/');

  if (toolName === 'bash' || toolName === 'git') {
    const command = toolName === 'git' ? `git ${normalized}` : normalized;
    for (const pattern of SHELL_PATTERNS) {
      if (pattern.re.test(command)) return pattern.reason;
    }
  }

  if (FILE_TOOLS.has(toolName) && SENSITIVE_FILE.test(normalized)) {
    return 'sensitive credential file';
  }

  return undefined;
}
