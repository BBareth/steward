import {
  ELEVATED_PERMISSIONS,
  permissionNames,
  permissionsFromNames,
  unknownPermissionNames,
} from '../discord/permissions.js';
import { checkMessageContent } from '../features/messages.js';
import { hashValue } from '../util/hash.js';
import { isSnowflake } from '../util/ids.js';
import type { Blueprint, BlueprintChannel, BlueprintOverwrite, Issue } from './schema.js';
import { blueprintSchema, parseBlueprintInput, schemaIssues } from './schema.js';

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  blueprint?: Blueprint;
  hash?: string;
  stats?: {
    roles: number;
    categories: number;
    channels: number;
    messages: number;
    panels: number;
    automod: number;
  };
}

const TEXT_LIKE = new Set(['text', 'announcement', 'forum', 'media']);
const VOICE_LIKE = new Set(['voice', 'stage']);

/** Every channel in the blueprint with its category (if any). */
export function allChannels(
  bp: Blueprint,
): Array<{ channel: BlueprintChannel; categoryKey: string | null; path: string }> {
  const out: Array<{ channel: BlueprintChannel; categoryKey: string | null; path: string }> = [];
  bp.categories.forEach((cat, ci) =>
    cat.channels.forEach((channel, i) =>
      out.push({ channel, categoryKey: cat.key, path: `categories.${ci}.channels.${i}` }),
    ),
  );
  bp.channels.forEach((channel, i) => out.push({ channel, categoryKey: null, path: `channels.${i}` }));
  return out;
}

/**
 * Validate a blueprint without touching Discord. Anything that depends on the
 * live server (existing IDs, hierarchy, the bot's own permissions) is checked
 * when a plan is produced, not here.
 */
export function validateBlueprint(input: unknown): ValidationResult {
  let raw: unknown;
  try {
    raw = parseBlueprintInput(input);
  } catch (error) {
    return { ok: false, errors: [{ path: '(root)', message: (error as Error).message }], warnings: [] };
  }
  const parsed = blueprintSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: schemaIssues(parsed.error), warnings: [] };
  const bp = parsed.data;
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });

  // ---- keys -------------------------------------------------------------------
  const roleKeys = new Map<string, number>();
  bp.roles.forEach((r, i) => {
    if (r.key === 'everyone')
      err(`roles.${i}.key`, '"everyone" is reserved; use the top-level "everyone" section');
    if (roleKeys.has(r.key)) err(`roles.${i}.key`, `duplicate role key "${r.key}"`);
    roleKeys.set(r.key, i);
  });
  const channelKinds = new Map<string, string>();
  bp.categories.forEach((c, i) => {
    if (channelKinds.has(c.key)) err(`categories.${i}.key`, `duplicate channel key "${c.key}"`);
    channelKinds.set(c.key, 'category');
  });
  const channels = allChannels(bp);
  for (const { channel, path } of channels) {
    if (channelKinds.has(channel.key)) err(`${path}.key`, `duplicate channel key "${channel.key}"`);
    channelKinds.set(channel.key, channel.type);
  }
  const ids = new Map<string, string>();
  const checkId = (id: string | undefined, path: string) => {
    if (!id) return;
    if (ids.has(id)) err(path, `Discord ID ${id} is bound to two entries (${ids.get(id)} and ${path})`);
    ids.set(id, path);
  };
  bp.roles.forEach((r, i) => checkId(r.id, `roles.${i}.id`));
  bp.categories.forEach((c, i) => checkId(c.id, `categories.${i}.id`));
  for (const { channel, path } of channels) checkId(channel.id, `${path}.id`);

  const unique = (items: Array<{ key: string }>, section: string) => {
    const seen = new Set<string>();
    items.forEach((it, i) => {
      if (seen.has(it.key)) err(`${section}.${i}.key`, `duplicate key "${it.key}"`);
      seen.add(it.key);
    });
  };
  unique(bp.messages, 'messages');
  unique(bp.automod, 'automod');
  unique(bp.self_roles?.panels ?? [], 'self_roles.panels');

  // ---- references -------------------------------------------------------------
  const roleRefOk = (ref: string, path: string) => {
    if (ref === 'everyone' || roleKeys.has(ref) || isSnowflake(ref)) return true;
    err(path, `unknown role "${ref}"; use a role key from "roles", "everyone", or a Discord role ID`);
    return false;
  };
  const channelRefOk = (ref: string, path: string, accept?: (kind: string) => boolean, what?: string) => {
    if (isSnowflake(ref)) return true;
    const kind = channelKinds.get(ref);
    if (!kind) {
      err(path, `unknown channel "${ref}"; use a channel or category key, or a Discord channel ID`);
      return false;
    }
    if (accept && !accept(kind)) {
      err(path, `"${ref}" is a ${kind} channel; ${what}`);
      return false;
    }
    return true;
  };

  const checkPerms = (names: readonly string[] | undefined, path: string) => {
    if (!names) return;
    const unknown = unknownPermissionNames(names);
    if (unknown.length > 0) err(path, `unknown permission name(s): ${unknown.join(', ')}`);
  };

  const checkOverwrites = (list: BlueprintOverwrite[] | undefined, path: string) => {
    if (!list) return;
    const targets = new Set<string>();
    list.forEach((o, i) => {
      const p = `${path}.${i}`;
      if (o.role !== undefined) roleRefOk(o.role, `${p}.role`);
      const target = o.role !== undefined ? `role:${o.role}` : `member:${o.member}`;
      if (targets.has(target)) err(p, `two overwrites for the same target (${target})`);
      targets.add(target);
      checkPerms(o.allow, `${p}.allow`);
      checkPerms(o.deny, `${p}.deny`);
      if (unknownPermissionNames([...o.allow, ...o.deny]).length === 0) {
        const both = permissionsFromNames(o.allow) & permissionsFromNames(o.deny);
        if (both !== 0n) err(p, `permissions both allowed and denied: ${permissionNames(both).join(', ')}`);
      }
    });
  };

  const checkAccess = (
    access: { visible_to?: string[]; writers?: string[]; private?: boolean; read_only?: boolean } | undefined,
    path: string,
  ) => {
    if (!access) return;
    access.visible_to?.forEach((r, i) => roleRefOk(r, `${path}.visible_to.${i}`));
    access.writers?.forEach((r, i) => roleRefOk(r, `${path}.writers.${i}`));
    if (access.visible_to?.length && !access.private)
      warn(path, '"visible_to" has no effect unless "private" is true');
    if (access.writers?.length && !access.read_only)
      warn(path, '"writers" has no effect unless "read_only" is true');
  };

  bp.roles.forEach((r, i) => checkPerms(r.permissions, `roles.${i}.permissions`));
  checkPerms(bp.everyone?.permissions, 'everyone.permissions');
  if (bp.everyone?.permissions && unknownPermissionNames(bp.everyone.permissions).length === 0) {
    const elevated = permissionsFromNames(bp.everyone.permissions) & ELEVATED_PERMISSIONS;
    if (elevated !== 0n) {
      warn(
        'everyone.permissions',
        `@everyone would get ${permissionNames(elevated).join(', ')}; every member of the server holds these`,
      );
    }
  }

  bp.categories.forEach((c, i) => {
    checkOverwrites(c.permissions, `categories.${i}.permissions`);
    checkAccess(c.access, `categories.${i}.access`);
  });

  for (const { channel: ch, categoryKey, path } of channels) {
    checkOverwrites(ch.permissions, `${path}.permissions`);
    checkAccess(ch.access, `${path}.access`);
    if (ch.sync_permissions && (ch.permissions || ch.access)) {
      err(
        path,
        '"sync_permissions" copies the category\'s permissions; it cannot be combined with "permissions" or "access"',
      );
    }
    if (ch.sync_permissions && !categoryKey)
      err(`${path}.sync_permissions`, 'only channels inside a category can sync permissions');
    if (TEXT_LIKE.has(ch.type) && /[A-Z\s]/.test(ch.name)) {
      err(
        `${path}.name`,
        `Discord stores ${ch.type} channel names in lower case with dashes; write "${ch.name.toLowerCase().replace(/\s+/g, '-')}" so plans stay stable`,
      );
    }
    if (VOICE_LIKE.has(ch.type) && ch.topic !== undefined && ch.type === 'voice') {
      err(`${path}.topic`, 'voice channels do not have a topic');
    }
    if (!VOICE_LIKE.has(ch.type) && (ch.bitrate !== undefined || ch.user_limit !== undefined)) {
      err(path, '"bitrate" and "user_limit" only apply to voice and stage channels');
    }
    if (VOICE_LIKE.has(ch.type) && ch.slowmode_seconds !== undefined && ch.type === 'stage') {
      warn(`${path}.slowmode_seconds`, 'slowmode on stage channels applies to the text chat only');
    }
  }

  // ---- settings ---------------------------------------------------------------
  const s = bp.settings;
  if (s) {
    const textOnly = (k: string) => TEXT_LIKE.has(k) && k !== 'forum' && k !== 'media';
    if (s.afk_channel)
      channelRefOk(
        s.afk_channel,
        'settings.afk_channel',
        (k) => k === 'voice',
        'the AFK channel must be a voice channel',
      );
    if (s.system_channel)
      channelRefOk(s.system_channel, 'settings.system_channel', textOnly, 'it must be a text channel');
    if (s.rules_channel)
      channelRefOk(s.rules_channel, 'settings.rules_channel', textOnly, 'it must be a text channel');
    if (s.public_updates_channel) {
      channelRefOk(
        s.public_updates_channel,
        'settings.public_updates_channel',
        textOnly,
        'it must be a text channel',
      );
    }
    if (s.safety_alerts_channel) {
      channelRefOk(
        s.safety_alerts_channel,
        'settings.safety_alerts_channel',
        textOnly,
        'it must be a text channel',
      );
    }
    if (s.community) {
      for (const field of ['rules_channel', 'public_updates_channel'] as const) {
        const ref = s[field];
        if (ref && channelKinds.get(ref) === 'announcement') {
          warn(
            `settings.${field}`,
            `"${ref}" is an announcement channel; when this blueprint turns Community on, it can only be created afterwards, so point ${field} at a text channel`,
          );
        }
      }
      if (!s.rules_channel) err('settings.community', 'a Community server needs "rules_channel"');
      if (!s.public_updates_channel)
        err('settings.community', 'a Community server needs "public_updates_channel"');
      if (s.verification_level === 'none')
        err('settings.verification_level', 'a Community server needs verification level "low" or higher');
      if (s.explicit_content_filter && s.explicit_content_filter !== 'all_members') {
        err(
          'settings.explicit_content_filter',
          'a Community server must scan media from all members ("all_members")',
        );
      }
    }
  }
  const needsCommunity = channels.filter(({ channel }) =>
    ['announcement', 'stage', 'media'].includes(channel.type),
  );
  if (needsCommunity.length > 0 && !s?.community) {
    warn(
      needsCommunity[0]!.path,
      'announcement, stage and media channels need the Community feature (announcement channels also work with the older NEWS feature); the plan will report them as unsupported unless the server already has it or "settings.community" is true',
    );
  }
  const forums = channels.filter(({ channel }) => channel.type === 'forum');
  if (forums.length > 0 && !s?.community) {
    warn(
      forums[0]!.path,
      'forum channels launched for Community servers, and Discord no longer documents whether that applies; if Discord refuses one, set "settings.community" to true, and steward creates it after turning Community on',
    );
  }

  // ---- messages ---------------------------------------------------------------
  bp.messages.forEach((m, i) => {
    channelRefOk(
      m.channel,
      `messages.${i}.channel`,
      (k) => TEXT_LIKE.has(k) && k !== 'forum' && k !== 'media',
      'messages need a text or announcement channel',
    );
    for (const p of checkMessageContent(m)) err(`messages.${i}`, p);
  });

  // ---- role safety: staff, self roles, join roles ----------------------------
  const roleByKey = new Map(bp.roles.map((r) => [r.key, r]));
  const unsafeReason = (ref: string): string | null => {
    if (ref === 'everyone') return '@everyone cannot be assigned';
    const r = roleByKey.get(ref);
    if (!r) return null; // raw IDs are checked against the live server at plan time
    if (r.staff) return `"${ref}" is marked as a staff role`;
    if (r.permissions && unknownPermissionNames(r.permissions).length === 0) {
      const elevated = permissionsFromNames(r.permissions) & ELEVATED_PERMISSIONS;
      if (elevated !== 0n) return `"${ref}" grants ${permissionNames(elevated).join(', ')}`;
    }
    const grantsElsewhere: string[] = [];
    const scan = (list: BlueprintOverwrite[] | undefined, where: string) => {
      for (const o of list ?? []) {
        if (o.role !== ref || unknownPermissionNames(o.allow).length > 0) continue;
        const elevated = permissionsFromNames(o.allow) & ELEVATED_PERMISSIONS;
        if (elevated !== 0n) grantsElsewhere.push(`${permissionNames(elevated).join(', ')} in ${where}`);
      }
    };
    bp.categories.forEach((c) => scan(c.permissions, c.key));
    for (const { channel } of channels) scan(channel.permissions, channel.key);
    if (grantsElsewhere.length > 0) return `"${ref}" grants ${grantsElsewhere.join('; ')}`;
    return null;
  };

  if (bp.welcome) {
    const w = bp.welcome;
    if (w.channel)
      channelRefOk(
        w.channel,
        'welcome.channel',
        (k) => k === 'text' || k === 'announcement',
        'welcome messages need a text channel',
      );
    if (w.message) for (const p of checkMessageContent(w.message)) err('welcome.message', p);
    if (w.enabled && w.message && !w.channel) err('welcome.channel', 'a welcome message needs a channel');
    w.join_roles.forEach((r, i) => {
      if (!roleRefOk(r, `welcome.join_roles.${i}`)) return;
      const why = unsafeReason(r);
      if (why) err(`welcome.join_roles.${i}`, `join roles must not be privileged: ${why}`);
    });
  }

  if (bp.self_roles) {
    const allow = new Set<string>();
    bp.self_roles.roles.forEach((r, i) => {
      if (!roleRefOk(r, `self_roles.roles.${i}`)) return;
      const why = unsafeReason(r);
      if (why) err(`self_roles.roles.${i}`, `self-assignable roles must not be privileged: ${why}`);
      allow.add(r);
    });
    bp.self_roles.panels.forEach((p, i) => {
      channelRefOk(
        p.channel,
        `self_roles.panels.${i}.channel`,
        (k) => k === 'text' || k === 'announcement',
        'panels need a text channel',
      );
      const seen = new Set<string>();
      p.options.forEach((o, j) => {
        if (!roleRefOk(o.role, `self_roles.panels.${i}.options.${j}.role`)) return;
        if (!allow.has(o.role))
          err(
            `self_roles.panels.${i}.options.${j}.role`,
            `"${o.role}" is not in self_roles.roles (the allowlist)`,
          );
        if (seen.has(o.role))
          err(`self_roles.panels.${i}.options.${j}.role`, `"${o.role}" appears twice on this panel`);
        seen.add(o.role);
      });
    });
  }

  // ---- automod ----------------------------------------------------------------
  const counts: Record<string, number> = {};
  bp.automod.forEach((a, i) => {
    counts[a.trigger.type] = (counts[a.trigger.type] ?? 0) + 1;
    if (
      a.trigger.type === 'keyword' &&
      a.trigger.keywords.length === 0 &&
      a.trigger.regex_patterns.length === 0
    ) {
      err(`automod.${i}.trigger`, 'a keyword rule needs "keywords" or "regex_patterns"');
    }
    a.actions.forEach((act, j) => {
      if (act.type === 'timeout' && a.trigger.type !== 'keyword' && a.trigger.type !== 'mention_spam') {
        err(
          `automod.${i}.actions.${j}`,
          'Discord only allows the timeout action on keyword and mention_spam rules',
        );
      }
      if (act.type === 'alert') {
        channelRefOk(
          act.channel,
          `automod.${i}.actions.${j}.channel`,
          (k) => k === 'text' || k === 'announcement',
          'alerts need a text channel',
        );
      }
    });
    a.exempt_roles.forEach((r, j) => roleRefOk(r, `automod.${i}.exempt_roles.${j}`));
    a.exempt_channels.forEach((c, j) => channelRefOk(c, `automod.${i}.exempt_channels.${j}`));
  });
  const limits: Record<string, number> = { keyword: 6, spam: 1, keyword_preset: 1, mention_spam: 1 };
  for (const [type, n] of Object.entries(counts)) {
    if (n > limits[type]!)
      err(
        'automod',
        `Discord allows at most ${limits[type]} ${type} rule(s) per server; the blueprint has ${n}`,
      );
  }

  // ---- size limits ------------------------------------------------------------
  const channelCount = channels.length + bp.categories.length;
  if (channelCount > 500)
    err('channels', `Discord allows 500 channels per server; the blueprint has ${channelCount}`);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    blueprint: errors.length === 0 ? bp : undefined,
    hash: errors.length === 0 ? hashValue(bp) : undefined,
    stats: {
      roles: bp.roles.length,
      categories: bp.categories.length,
      channels: channels.length,
      messages: bp.messages.length,
      panels: bp.self_roles?.panels.length ?? 0,
      automod: bp.automod.length,
    },
  };
}
