/**
 * Selection model for a checkbox tree. Pure data, no terminal I/O, so it can
 * be unit-tested; `tree-prompt.ts` renders it with @clack/core.
 */

export interface TreeNode {
  label: string;
  /** Leaf value. Nodes with children have no value of their own. */
  value?: string;
  hint?: string;
  children?: TreeNode[];
}

export interface TreeRow {
  node: TreeNode;
  depth: number;
  parent?: TreeNode;
}

export type CheckState = 'none' | 'some' | 'all';

export class TreeModel {
  readonly selected = new Set<string>();
  private readonly expanded = new Set<TreeNode>();
  cursor = 0;

  constructor(
    readonly roots: TreeNode[],
    opts: { expandDepth?: number; initialSelected?: Iterable<string> } = {}
  ) {
    const depth = opts.expandDepth ?? 1;
    const expand = (nodes: TreeNode[], d: number) => {
      if (d >= depth) return;
      for (const n of nodes) {
        if (n.children?.length) {
          this.expanded.add(n);
          expand(n.children, d + 1);
        }
      }
    };
    expand(roots, 0);
    for (const v of opts.initialSelected ?? []) this.selected.add(v);
  }

  /** Visible rows in display order, honoring collapsed nodes. */
  rows(): TreeRow[] {
    const out: TreeRow[] = [];
    const walk = (nodes: TreeNode[], depth: number, parent?: TreeNode) => {
      for (const node of nodes) {
        out.push({ node, depth, parent });
        if (node.children?.length && this.expanded.has(node)) walk(node.children, depth + 1, node);
      }
    };
    walk(this.roots, 0);
    return out;
  }

  current(): TreeRow | undefined {
    return this.rows()[this.cursor];
  }

  isExpanded(node: TreeNode): boolean {
    return this.expanded.has(node);
  }

  leaves(node: TreeNode): string[] {
    if (!node.children?.length) return node.value !== undefined ? [node.value] : [];
    return node.children.flatMap((c) => this.leaves(c));
  }

  state(node: TreeNode): CheckState {
    const leaves = this.leaves(node);
    if (leaves.length === 0) return 'none';
    const n = leaves.filter((l) => this.selected.has(l)).length;
    return n === 0 ? 'none' : n === leaves.length ? 'all' : 'some';
  }

  /** Space: leaf toggles; parent selects all descendants unless already all. */
  toggle(): void {
    const row = this.current();
    if (!row) return;
    const leaves = this.leaves(row.node);
    if (this.state(row.node) === 'all') {
      for (const l of leaves) this.selected.delete(l);
    } else {
      for (const l of leaves) this.selected.add(l);
    }
  }

  move(delta: 1 | -1): void {
    const n = this.rows().length;
    if (n === 0) return;
    this.cursor = (this.cursor + delta + n) % n;
  }

  /** Right: expand. On a leaf or an open node, nothing happens. */
  expand(): void {
    const row = this.current();
    if (row?.node.children?.length) this.expanded.add(row.node);
  }

  /** Left: collapse an open node; on a closed node or leaf, jump to its parent. */
  collapse(): void {
    const row = this.current();
    if (!row) return;
    if (row.node.children?.length && this.expanded.has(row.node)) {
      this.expanded.delete(row.node);
      return;
    }
    if (row.parent) {
      const idx = this.rows().findIndex((r) => r.node === row.parent);
      if (idx >= 0) this.cursor = idx;
    }
  }

  toggleExpand(): void {
    const row = this.current();
    if (!row?.node.children?.length) return;
    if (this.expanded.has(row.node)) this.expanded.delete(row.node);
    else this.expanded.add(row.node);
  }
}
