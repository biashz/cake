export interface SlashCommand {
  name: string;
  hint: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'new', hint: 'Start a new session' },
  { name: 'clear', hint: 'Clear the transcript with a new session' },
  { name: 'cost', hint: 'Show session tokens and cost' },
  { name: 'model', hint: 'Choose provider and model' },
  { name: 'mode', hint: 'Change permission mode' },
  { name: 'files', hint: 'Browse workspace files' },
  { name: 'mcp', hint: 'Inspect MCP servers and diagnostics' },
  { name: 'doctor', hint: 'Run environment diagnostics' },
  { name: 'help', hint: 'Show keyboard shortcuts and commands' },
];
