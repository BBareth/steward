import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Store } from '../src/store.js';

test('state survives a restart and migrations are idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-persist-'));
  const path = join(dir, 'nested', 'steward.db');
  const g = '123456789012345678';
  try {
    const a = new Store(path);
    a.setMapping(g, 'role', 'mod', '111111111111111111', 'created');
    a.setWelcome({
      guildId: g,
      enabled: true,
      channelId: '222222222222222222',
      message: { content: 'hi' },
      joinRoleIds: ['333333333333333333'],
    });
    a.addSelfRole(g, '444444444444444444');
    a.addProtectedRole(g, '111111111111111111');
    a.upsertPanel({
      id: 'rp_1',
      guildId: g,
      key: 'p',
      channelId: '5',
      messageId: '6',
      title: 'T',
      description: null,
      mode: 'single',
      options: [{ roleId: '444444444444444444', label: 'L' }],
    });
    a.setManagedMessage({ guildId: g, key: 'rules', channelId: '7', messageId: '8', payloadHash: 'abc' });
    a.startOperation({
      id: 'op_1',
      guildId: g,
      planId: null,
      stepId: null,
      tool: 't',
      clientId: 'c',
      action: 'create_role',
      resourceKind: 'role',
      resourceKey: 'x',
      targetId: null,
      summary: 's',
      auditReason: 'r',
      matchJson: null,
    });
    a.close();

    const b = new Store(path);
    expect(b.schemaVersion()).toBe(1);
    expect(b.getMapping(g, 'role', 'mod')?.discordId).toBe('111111111111111111');
    expect(b.getWelcome(g)).toMatchObject({
      enabled: true,
      joinRoleIds: ['333333333333333333'],
      message: { content: 'hi' },
    });
    expect(b.listSelfRoles(g)).toEqual(['444444444444444444']);
    expect(b.listProtectedRoles(g)).toEqual(['111111111111111111']);
    expect(b.getPanelByKey(g, 'p')).toMatchObject({ mode: 'single', options: [{ label: 'L' }] });
    expect(b.getManagedMessage(g, 'rules')?.messageId).toBe('8');
    // The in-flight operation from the "crashed" process becomes uncertain, not silently done.
    expect(b.markInterrupted().operations).toBe(1);
    expect(b.getOperation('op_1')!.status).toBe('uncertain');
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one Discord resource never carries two keys', () => {
  const s = new Store(':memory:');
  const g = '123456789012345678';
  s.setMapping(g, 'channel', 'old', '999999999999999999', 'created');
  s.setMapping(g, 'channel', 'new', '999999999999999999', 'manual');
  expect(s.getMapping(g, 'channel', 'old')).toBeUndefined();
  expect(s.findMappingById(g, 'channel', '999999999999999999')?.key).toBe('new');
  s.close();
});
