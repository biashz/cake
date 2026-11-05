import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const StateSchema = z.object({
  lastWorkspace: z.string().optional(),
  /** Workspaces opened recently, most recent first. */
  recents: z.array(z.string()).max(20).optional(),
});

export type DesktopState = z.infer<typeof StateSchema>;

export function desktopStateFile(userDataDir: string): string {
  return path.join(userDataDir, 'state.json');
}

/** Missing or unreadable state is not fatal: the app just starts without a workspace. */
export async function loadDesktopState(file: string): Promise<DesktopState> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = StateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export async function saveDesktopState(file: string, state: DesktopState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
