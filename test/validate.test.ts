import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { validateBlueprint } from '../src/blueprint/validate.js';

const errorsOf = (bp: unknown) =>
  validateBlueprint(bp)
    .errors.map((e) => `${e.path}: ${e.message}`)
    .join('\n');

describe('blueprint validation', () => {
  test('the shipped community example is valid', () => {
    const v = validateBlueprint(readFileSync('examples/community.yaml', 'utf8'));
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.stats).toMatchObject({ roles: 10, categories: 5 });
  });

  test('accepts JSON text and objects; rejects garbage and unknown fields', () => {
    expect(validateBlueprint('{"version":1}').ok).toBe(true);
    expect(validateBlueprint({ version: 1 }).ok).toBe(true);
    expect(errorsOf('version: [')).toMatch(/not valid YAML or JSON/);
    expect(errorsOf({ version: 1, rolez: [] })).toMatch(/Unrecognized key/i);
    expect(errorsOf({ version: 2 })).toMatch(/version/);
  });

  test('keys must be unique and well-formed; names are not identities', () => {
    expect(
      errorsOf({
        version: 1,
        roles: [
          { key: 'mod', name: 'Mod' },
          { key: 'mod', name: 'Moderator' },
        ],
        categories: [{ key: 'x', name: 'Same', channels: [{ key: 'x', name: 'same' }] }],
      }),
    ).toMatch(/duplicate role key "mod"[\s\S]*duplicate channel key "x"/);
    const shape = errorsOf({
      version: 1,
      roles: [
        { key: 'Bad Key', name: 'x' },
        { key: '123456789012345678', name: 'y' },
      ],
    });
    expect(shape).toMatch(/keys are 1-64 characters/);
    expect(shape).toMatch(/must not look like a Discord ID/);
    // Two roles may share a name; keys tell them apart.
    expect(
      validateBlueprint({
        version: 1,
        roles: [
          { key: 'a', name: 'Same' },
          { key: 'b', name: 'Same' },
        ],
      }).ok,
    ).toBe(true);
  });

  test('references must resolve and permission names must exist', () => {
    const e = errorsOf({
      version: 1,
      roles: [{ key: 'mod', name: 'Mod', permissions: ['KickMembers', 'FlyAround'] }],
      categories: [
        { key: 'staff', name: 'Staff', access: { private: true, visible_to: ['moderators'] }, channels: [] },
      ],
      channels: [
        {
          key: 'general',
          name: 'general',
          permissions: [{ role: 'mod', allow: ['SendMessages'], deny: ['SendMessages'] }],
        },
      ],
      messages: [{ key: 'm', channel: 'nowhere', content: 'hi' }],
    });
    expect(e).toMatch(/unknown permission name\(s\): FlyAround/);
    expect(e).toMatch(/unknown role "moderators"/);
    expect(e).toMatch(/both allowed and denied: SendMessages/);
    expect(e).toMatch(/unknown channel "nowhere"/);
  });

  test('text channel names must already be in Discord form', () => {
    expect(errorsOf({ version: 1, channels: [{ key: 'g', name: 'General Chat' }] })).toMatch(
      /write "general-chat"/,
    );
    expect(
      validateBlueprint({ version: 1, channels: [{ key: 'v', name: 'Voice Lounge', type: 'voice' }] }).ok,
    ).toBe(true);
  });

  test('sync_permissions conflicts and type-specific fields', () => {
    const e = errorsOf({
      version: 1,
      categories: [
        {
          key: 'c',
          name: 'C',
          channels: [{ key: 'x', name: 'x', sync_permissions: true, access: { private: true } }],
        },
      ],
      channels: [
        { key: 'y', name: 'y', bitrate: 64000 },
        { key: 'z', name: 'z', sync_permissions: true },
      ],
    });
    expect(e).toMatch(/cannot be combined/);
    expect(e).toMatch(/only apply to voice and stage/);
    expect(e).toMatch(/only channels inside a category can sync/);
  });

  test('self-assignable and join roles must not be privileged', () => {
    const e = errorsOf({
      version: 1,
      roles: [
        { key: 'admin', name: 'Admin', permissions: ['Administrator'] },
        { key: 'staff', name: 'Staff', staff: true },
        { key: 'helper', name: 'Helper' },
        { key: 'gamer', name: 'Gamer' },
      ],
      channels: [
        { key: 'support', name: 'support', permissions: [{ role: 'helper', allow: ['ManageMessages'] }] },
        { key: 'roles', name: 'roles' },
      ],
      welcome: { enabled: true, join_roles: ['staff'] },
      self_roles: {
        roles: ['admin', 'helper', 'gamer'],
        panels: [
          {
            key: 'p',
            channel: 'roles',
            title: 'Pick',
            options: [
              { role: 'gamer', label: 'G' },
              { role: 'artist', label: 'A' },
            ],
          },
        ],
      },
    });
    expect(e).toMatch(
      /self_roles.roles.0: self-assignable roles must not be privileged: "admin" grants Administrator/,
    );
    expect(e).toMatch(/"helper" grants ManageMessages in support/);
    expect(e).toMatch(/join roles must not be privileged: "staff" is marked as a staff role/);
    expect(e).toMatch(/unknown role "artist"/);
  });

  test('community prerequisites and AutoMod limits', () => {
    const e = errorsOf({
      version: 1,
      settings: { community: true, verification_level: 'none' },
      automod: [
        {
          key: 'a',
          name: 'a',
          trigger: { type: 'spam' },
          actions: [{ type: 'timeout', duration_seconds: 60 }],
        },
        { key: 'b', name: 'b', trigger: { type: 'spam' }, actions: [{ type: 'block_message' }] },
        { key: 'c', name: 'c', trigger: { type: 'keyword' }, actions: [{ type: 'block_message' }] },
      ],
    });
    expect(e).toMatch(/needs "rules_channel"/);
    expect(e).toMatch(/verification level "low" or higher/);
    expect(e).toMatch(/timeout action on keyword and mention_spam/);
    expect(e).toMatch(/at most 1 spam rule/);
    expect(e).toMatch(/needs "keywords" or "regex_patterns"/);
  });

  test('YAML alias bombs are refused', () => {
    const bomb = [
      'a: &a [x,x,x,x,x,x,x,x,x,x]',
      ...Array.from(
        { length: 12 },
        (_, i) =>
          `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)}]`,
      ),
    ].join('\n');
    expect(validateBlueprint(bomb).ok).toBe(false);
  });
});
