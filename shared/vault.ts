/** What GET /api/vault returns. Titles, relative paths and link targets only; never note bodies. */
export type VaultInfo =
  | { connected: false }
  | {
      connected: true;
      /** Base name of the vault folder. */
      name: string;
      noteCount: number;
      /** The five most recently changed notes. `path` is relative, with forward slashes. */
      recent: { title: string; path: string; mtime: number }[];
      nodes: { id: string; title: string }[];
      links: { from: string; to: string }[];
    };
