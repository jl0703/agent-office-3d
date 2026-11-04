import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const ACTIVE_WINDOW_MS = 10_000;

/**
 * True when the session's log file was written to recently, which means something else is still
 * working on that conversation. Only file times are read, only under the projects folder, and an
 * id that is not a plain name is never looked up.
 */
export async function transcriptActive(projectsDir: string, id: string, now = Date.now(), windowMs = ACTIVE_WINDOW_MS): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return false;
  let folders: string[];
  try {
    folders = await readdir(projectsDir);
  } catch {
    return false;
  }
  for (const folder of folders) {
    try {
      if (now - (await stat(join(projectsDir, folder, `${id}.jsonl`))).mtimeMs < windowMs) return true;
    } catch {
      // no such file in this folder
    }
  }
  return false;
}
