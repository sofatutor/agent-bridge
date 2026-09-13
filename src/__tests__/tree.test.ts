import { describe, it, expect } from 'vite-plus/test';
import { TreeModel, type TreeNode } from '../lib/tree.js';

const tree: TreeNode[] = [
  {
    label: 'hub',
    children: [
      {
        label: 'shared',
        children: [
          { label: 'skills', children: [{ label: 'a', value: 'shared/skills/a' }, { label: 'b', value: 'shared/skills/b' }] },
          { label: 'files', children: [{ label: 'AGENTS.md', value: 'shared/AGENTS.md' }] },
        ],
      },
      { label: 'empty', value: 'empty/' },
    ],
  },
];

describe('TreeModel', () => {
  it('starts with roots expanded and deeper levels collapsed', () => {
    const m = new TreeModel(tree);
    expect(m.rows().map((r) => r.node.label)).toEqual(['hub', 'shared', 'empty']);
  });

  it('ticking a parent selects every leaf beneath it; ticking again clears them', () => {
    const m = new TreeModel(tree);
    m.cursor = 1; // shared
    m.toggle();
    expect([...m.selected].sort()).toEqual(['shared/AGENTS.md', 'shared/skills/a', 'shared/skills/b']);
    expect(m.state(tree[0].children![0])).toBe('all');
    expect(m.state(tree[0])).toBe('some');
    m.toggle();
    expect(m.selected.size).toBe(0);
  });

  it('a partially selected parent becomes fully selected on toggle', () => {
    const m = new TreeModel(tree, { initialSelected: ['shared/skills/a'] });
    expect(m.state(tree[0].children![0])).toBe('some');
    m.cursor = 1;
    m.toggle();
    expect(m.state(tree[0].children![0])).toBe('all');
  });

  it('expand and collapse change the visible rows; collapse on a leaf jumps to the parent', () => {
    const m = new TreeModel(tree);
    m.cursor = 1;
    m.expand();
    expect(m.rows().map((r) => r.node.label)).toEqual(['hub', 'shared', 'skills', 'files', 'empty']);
    m.cursor = 2;
    m.expand();
    m.cursor = 3; // 'a'
    m.collapse();
    expect(m.current()?.node.label).toBe('skills');
    m.collapse();
    expect(m.rows().map((r) => r.node.label)).toEqual(['hub', 'shared', 'skills', 'files', 'empty']);
  });

  it('cursor wraps around', () => {
    const m = new TreeModel(tree);
    m.move(-1);
    expect(m.current()?.node.label).toBe('empty');
    m.move(1);
    expect(m.current()?.node.label).toBe('hub');
  });

  it('a leaf without children is toggled directly', () => {
    const m = new TreeModel(tree);
    m.cursor = 2;
    m.toggle();
    expect([...m.selected]).toEqual(['empty/']);
  });
});
