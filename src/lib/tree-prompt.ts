import { Prompt, isCancel } from '@clack/core';
import { TreeModel, type TreeNode, type CheckState } from './tree.js';

// Minimal ANSI styling (matches @clack/prompts' look without adding a dep).
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[39m` : s);
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s);
const cyan = (s: string) => paint(36, s);
const green = (s: string) => paint(32, s);
const yellow = (s: string) => paint(33, s);
const red = (s: string) => paint(31, s);
const gray = (s: string) => paint(90, s);

const S_BAR = '│';
const S_BAR_END = '└';
const CHECK: Record<CheckState, string> = { none: '◻', some: yellow('◧'), all: green('◼') };

function symbol(state: string): string {
  if (state === 'cancel') return red('■');
  if (state === 'error') return yellow('▲');
  if (state === 'submit') return green('◇');
  return cyan('◆');
}

export interface TreeSelectOptions {
  message: string;
  tree: TreeNode[];
  /** How many levels start expanded (default 1 = roots open). */
  expandDepth?: number;
  initialValues?: string[];
  required?: boolean;
  /** Max visible rows (default: terminal height − 6, at least 5). */
  maxItems?: number;
}

/**
 * A checkbox tree. Space toggles the node under the cursor (a parent toggles
 * everything beneath it), ←/→ collapse/expand, Enter confirms.
 * Resolves to the selected leaf values, or the clack cancel symbol.
 */
export async function treeSelect(opts: TreeSelectOptions): Promise<string[] | symbol> {
  const model = new TreeModel(opts.tree, {
    expandDepth: opts.expandDepth,
    initialSelected: opts.initialValues,
  });
  const maxItems = Math.max(5, opts.maxItems ?? (process.stdout.rows || 24) - 6);

  const prompt = new Prompt(
    {
      validate: () => {
        if (opts.required !== false && model.selected.size === 0) return 'Select at least one item.';
      },
      render() {
        const title = `${gray(S_BAR)}\n${symbol(this.state)}  ${opts.message}\n`;
        if (this.state === 'submit') {
          const n = model.selected.size;
          return `${title}${gray(S_BAR)}  ${dim(`${n} item${n === 1 ? '' : 's'} selected`)}`;
        }
        if (this.state === 'cancel') {
          return `${title}${gray(S_BAR)}  ${dim('cancelled')}\n${gray(S_BAR)}`;
        }

        const rows = model.rows();
        // Keep the cursor inside a window of `maxItems` rows.
        let start = 0;
        if (rows.length > maxItems) {
          start = Math.min(Math.max(0, model.cursor - Math.floor(maxItems / 2)), rows.length - maxItems);
        }
        const end = Math.min(rows.length, start + maxItems);

        const lines: string[] = [];
        if (start > 0) lines.push(`${cyan(S_BAR)}  ${dim('…')}`);
        for (let i = start; i < end; i++) {
          const { node, depth } = rows[i];
          const active = i === model.cursor;
          const hasKids = !!node.children?.length;
          const arrow = hasKids ? (model.isExpanded(node) ? '▾' : '▸') : ' ';
          const box = CHECK[model.state(node)];
          const indent = '  '.repeat(depth);
          let label = active ? node.label : dim(node.label);
          if (node.hint) label += ` ${dim(node.hint)}`;
          lines.push(`${cyan(S_BAR)}  ${indent}${dim(arrow)} ${box} ${label}`);
        }
        if (end < rows.length) lines.push(`${cyan(S_BAR)}  ${dim('…')}`);

        const footer =
          this.state === 'error'
            ? `${yellow(S_BAR_END)}  ${yellow(this.error)}`
            : `${cyan(S_BAR_END)}  ${dim('space toggle · ←/→ collapse/expand · enter confirm')}`;
        return `${title}${lines.join('\n')}\n${footer}\n`;
      },
    },
    false
  );

  prompt.on('cursor', (key) => {
    switch (key) {
      case 'up':
        model.move(-1);
        break;
      case 'down':
        model.move(1);
        break;
      case 'left':
        model.collapse();
        break;
      case 'right':
        model.expand();
        break;
      case 'space':
        model.toggle();
        break;
    }
    prompt.value = [...model.selected];
  });
  prompt.value = [...model.selected];

  const result = await prompt.prompt();
  if (isCancel(result)) return result;
  return [...model.selected];
}
