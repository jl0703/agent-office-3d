import type { VaultInfo } from "../../shared/vault.ts";

export type Vault = Extract<VaultInfo, { connected: true }>;
export type VaultNode = Vault["nodes"][number];

export const MAX_GRAPH_NODES = 200;

/** A link that opens a note in Obsidian. The scheme is fixed; the vault name and path are encoded, never trusted as markup. */
export function obsidianLink(vaultName: string, path: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(path.replace(/\.md$/i, ""))}`;
}

/** Notes whose title contains the text, ignoring case. An empty query matches nothing: the list is for finding. */
export function searchTitles(nodes: readonly VaultNode[], query: string, max = 50): VaultNode[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  return nodes.filter((n) => n.title.toLowerCase().includes(needle)).slice(0, max);
}

export type GraphLayout = {
  /** x, y, z for each node, about the centre of the hub's core. */
  positions: number[];
  sizes: number[];
  /** Pairs of points, six numbers per link. */
  lines: number[];
};

/**
 * Places the notes on shells around the hub's core: the most linked closest, spread evenly over the
 * sphere. Pure and deterministic, so the picture of a vault does not change from one scan to the next.
 */
export function graphLayout(nodes: readonly VaultNode[], links: readonly Vault["links"][number][]): GraphLayout {
  const degree = new Map<string, number>();
  for (const n of nodes) degree.set(n.id, 0);
  for (const l of links) {
    if (degree.has(l.from) && degree.has(l.to)) {
      degree.set(l.from, (degree.get(l.from) as number) + 1);
      degree.set(l.to, (degree.get(l.to) as number) + 1);
    }
  }
  const ranked = nodes.slice(0, MAX_GRAPH_NODES).sort((a, b) => (degree.get(b.id) as number) - (degree.get(a.id) as number) || a.id.localeCompare(b.id));
  const maxDegree = Math.max(1, ...ranked.map((n) => degree.get(n.id) as number));
  const golden = Math.PI * (3 - Math.sqrt(5));
  const where = new Map<string, [number, number, number]>();
  const positions: number[] = [];
  const sizes: number[] = [];
  ranked.forEach((n, i) => {
    const y = ranked.length === 1 ? 0 : 1 - (2 * i) / (ranked.length - 1);
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = i * golden;
    const radius = 1.7 + 1.3 * (ranked.length === 1 ? 0 : i / (ranked.length - 1));
    const p: [number, number, number] = [Math.cos(angle) * ring * radius, y * radius, Math.sin(angle) * ring * radius];
    where.set(n.id, p);
    positions.push(...p);
    sizes.push(0.07 + (0.11 * (degree.get(n.id) as number)) / maxDegree);
  });
  const lines: number[] = [];
  for (const l of links) {
    const a = where.get(l.from);
    const b = where.get(l.to);
    if (a && b) lines.push(...a, ...b);
  }
  return { positions, sizes, lines };
}

/** A made-up vault for demo mode: 60 notes in a few clusters, nothing read from disk. */
export function demoVault(): Vault {
  const topics = ["Architecture", "Meetings", "Research", "Ideas", "Journal"];
  const nodes: Vault["nodes"] = [];
  const links: Vault["links"] = [];
  for (let i = 0; i < 60; i++) {
    const topic = topics[i % topics.length] as string;
    nodes.push({ id: `${topic}/Note ${i + 1}.md`, title: `${topic} note ${i + 1}` });
    if (i >= topics.length) links.push({ from: (nodes[i] as VaultNode).id, to: (nodes[i % topics.length] as VaultNode).id });
    if (i % 7 === 0 && i > 7) links.push({ from: (nodes[i] as VaultNode).id, to: (nodes[i - 7] as VaultNode).id });
  }
  const now = Date.UTC(2026, 0, 1);
  return {
    connected: true,
    name: "Demo vault",
    noteCount: nodes.length,
    recent: nodes.slice(-5).reverse().map((n, i) => ({ title: n.title, path: n.id, mtime: now - i * 3600_000 })),
    nodes,
    links,
  };
}
