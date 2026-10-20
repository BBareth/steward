import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { validateBlueprint } from '../src/blueprint/validate.js';
import { ALL_TOOLS } from '../src/mcp/server.js';
import { makeEnv } from './helpers/env.js';

const doc = readFileSync('docs/BLUEPRINTS.md', 'utf8');
const example = readFileSync('examples/community.yaml', 'utf8');

test('the complete example in BLUEPRINTS.md is examples/community.yaml', () => {
  const block =
    /<!-- community\.yaml begins[^\n]*\n```yaml\n([\s\S]*?)```\n<!-- community\.yaml ends -->/.exec(doc);
  expect(block?.[1]).toBe(example);
});

test('every YAML snippet in BLUEPRINTS.md that is a whole blueprint validates', () => {
  const snippets = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const whole = snippets.filter((s) => /^version: 1/m.test(s) && !s.includes('...'));
  expect(whole.length).toBeGreaterThan(0);
  for (const s of whole) expect(validateBlueprint(s).errors).toEqual([]);
});

test('the numbers quoted for the complete example are what the planner produces', async () => {
  const env = makeEnv();
  try {
    const { body } = await env.service.createPlan({
      guildId: env.guildId,
      blueprint: example,
      clientId: 't',
    });
    expect(doc).toContain(
      `plans ${body.summary.create}\ncreates, ${body.summary.update} updates and ${body.summary.reorder} reorders`,
    );
  } finally {
    env.cleanup();
  }
});

test('the README tool table lists every tool exactly once, with its scope', () => {
  const readme = readFileSync('README.md', 'utf8');
  for (const tool of ALL_TOOLS) {
    const row = readme.split('\n').find((l) => l.startsWith('|') && l.includes(`\`${tool.name}\``));
    expect(row, tool.name).toBeDefined();
    expect(row!.trim(), `${tool.name} scope`).toMatch(new RegExp(`\\|\\s*${tool.scope}\\s*\\|$`));
  }
  expect(readme).toContain(`${ALL_TOOLS.length} typed tools`);
});
