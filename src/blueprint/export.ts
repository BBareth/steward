import { permissionNames, rolesTopDown } from '../discord/permissions.js';
import type {
  AutoModRuleInfo,
  ChannelInfo,
  GuildSnapshot,
  MessageEmbed,
  MessageInfo,
  Overwrite,
} from '../discord/types.js';
import { formatColor } from '../features/messages.js';
import { bucketMembers } from '../ops/ordering.js';
import type { ManagedMessage, Mapping, MappingKind, RolePanel, WelcomeConfig } from '../store.js';
import {
  KEY_RE,
  AUTOMOD_PRESETS,
  CONTENT_FILTERS,
  NOTIFICATION_LEVELS,
  SYSTEM_CHANNEL_FLAGS,
  VERIFICATION_LEVELS,
} from './schema.js';

export interface ExportInput {
  snapshot: GuildSnapshot;
  mappings: Mapping[];
  automodRules: AutoModRuleInfo[] | null;
  managedMessages: Array<ManagedMessage & { message: MessageInfo | null }>;
  welcome: WelcomeConfig | undefined;
  selfRoles: string[];
  protectedRoles: string[];
  panels: RolePanel[];
  includeIds: boolean;
}

export interface ExportResult {
  blueprint: Record<string, unknown>;
  /** Keys assigned to Discord resources; the caller records them as mappings. */
  keys: Array<{ kind: MappingKind; key: string; id: string; isNew: boolean }>;
  notes: string[];
}

const reverse = <T extends Record<string, number>>(o: T) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k])) as Record<number, keyof T & string>;

export function slugify(name: string, fallback: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 48);
  if (!s || /^\d{17,20}$/.test(s) || !KEY_RE.test(s)) return fallback;
  return s;
}

class KeyAllocator {
  private used = new Map<MappingKind, Set<string>>();
  readonly assigned: ExportResult['keys'] = [];
  private byId = new Map<string, string>();

  constructor(private readonly mappings: Mapping[]) {
    for (const m of mappings) this.taken(m.kind).add(m.key);
  }

  private taken(kind: MappingKind) {
    if (!this.used.has(kind)) this.used.set(kind, new Set());
    return this.used.get(kind)!;
  }

  key(kind: MappingKind, id: string, name: string, fallbackPrefix: string): string {
    const cached = this.byId.get(`${kind}:${id}`);
    if (cached) return cached;
    const mapped = this.mappings.find((m) => m.kind === kind && m.discordId === id);
    let key: string;
    if (mapped) {
      key = mapped.key;
    } else {
      const base = slugify(name, `${fallbackPrefix}-${id.slice(-6)}`);
      key = base === 'everyone' ? 'everyone-role' : base;
      let n = 2;
      while (this.taken(kind).has(key)) key = `${base}-${n++}`;
      this.taken(kind).add(key);
    }
    this.byId.set(`${kind}:${id}`, key);
    this.assigned.push({ kind, key, id, isNew: !mapped });
    return key;
  }

  existing(kind: MappingKind, id: string): string | undefined {
    return this.byId.get(`${kind}:${id}`);
  }
}

const embedOut = (e: MessageEmbed) => ({
  ...e,
  ...(e.color !== undefined ? { color: formatColor(e.color) } : {}),
});

/** Turn the live server (plus steward's own records) into a blueprint. */
export function exportBlueprint(input: ExportInput): ExportResult {
  const { snapshot: s } = input;
  const notes: string[] = [];
  const keys = new KeyAllocator(input.mappings);
  const prot = new Set(input.protectedRoles);
  const guildId = s.guild.id;

  const roles = rolesTopDown(s).filter((r) => r.id !== guildId && !r.managed);
  const managed = rolesTopDown(s).filter((r) => r.managed);
  if (managed.length > 0) {
    notes.push(
      `${managed.length} integration-managed role(s) (bots, boosters) are not exported; overwrites that mention them use their raw IDs: ${managed.map((r) => r.name).join(', ')}`,
    );
  }
  const roleOut = roles.map((r) => {
    const key = keys.key('role', r.id, r.name, 'role');
    return {
      key,
      name: r.name,
      ...(input.includeIds ? { id: r.id } : {}),
      ...(r.color ? { color: formatColor(r.color) } : {}),
      hoist: r.hoist,
      mentionable: r.mentionable,
      permissions: permissionNames(r.permissions),
      ...(prot.has(r.id) ? { staff: true } : {}),
    };
  });
  const roleRef = (id: string) => (id === guildId ? 'everyone' : (keys.existing('role', id) ?? id));

  const overwritesOut = (list: Overwrite[]) =>
    list.map((o) => ({
      ...(o.type === 'role' ? { role: roleRef(o.id) } : { member: o.id }),
      allow: permissionNames(o.allow),
      deny: permissionNames(o.deny),
    }));
  const sameOverwrites = (a: Overwrite[], b: Overwrite[]) =>
    a.length === b.length &&
    a.every((o) => b.some((p) => p.id === o.id && p.allow === o.allow && p.deny === o.deny));

  const channelKey = (c: ChannelInfo) =>
    keys.key('channel', c.id, c.name, c.kind === 'category' ? 'category' : 'channel');

  const channelOut = (c: ChannelInfo, category: ChannelInfo | null, categoryManaged: boolean) => {
    const out: Record<string, unknown> = { key: channelKey(c), name: c.name, type: c.kind };
    if (input.includeIds) out.id = c.id;
    if (c.topic && c.kind !== 'voice') out.topic = c.topic;
    if (c.nsfw) out.nsfw = true;
    if (c.rateLimitPerUser) out.slowmode_seconds = c.rateLimitPerUser;
    if (c.kind === 'voice' || c.kind === 'stage') {
      if (c.bitrate) out.bitrate = c.bitrate;
      if (c.userLimit) out.user_limit = c.userLimit;
    }
    if (category && categoryManaged) {
      if (!sameOverwrites(c.overwrites, category.overwrites)) out.permissions = overwritesOut(c.overwrites);
    } else if (c.overwrites.length > 0) {
      out.permissions = overwritesOut(c.overwrites);
    }
    return out;
  };

  const bucketed = (parentId: string | null) => [
    ...bucketMembers(s, parentId, 'text'),
    ...bucketMembers(s, parentId, 'voice'),
  ];
  const categories = bucketMembers(s, null, 'category');
  const categoriesOut = categories.map((cat) => {
    const managedPerms = cat.overwrites.length > 0;
    return {
      key: channelKey(cat),
      name: cat.name,
      ...(input.includeIds ? { id: cat.id } : {}),
      ...(managedPerms ? { permissions: overwritesOut(cat.overwrites) } : {}),
      channels: bucketed(cat.id).map((c) => channelOut(c, cat, managedPerms)),
    };
  });
  const topLevel = bucketed(null).map((c) => channelOut(c, null, false));
  const skipped = s.channels.filter((c) => c.kind === 'other');
  if (skipped.length > 0)
    notes.push(
      `${skipped.length} channel(s) of unsupported types were not exported: ${skipped.map((c) => c.name).join(', ')}`,
    );

  // Channel keys must exist before anything refers to them.
  const chRef = (id: string | null) => (id ? (keys.existing('channel', id) ?? id) : null);
  const g = s.guild;
  const flagsOut: Record<string, boolean> = {};
  for (const [name, bit] of Object.entries(SYSTEM_CHANNEL_FLAGS))
    flagsOut[name] = (g.systemChannelFlags & bit) !== 0;
  const settings: Record<string, unknown> = {
    verification_level: reverse(VERIFICATION_LEVELS)[g.verificationLevel],
    default_notifications: reverse(NOTIFICATION_LEVELS)[g.defaultMessageNotifications],
    explicit_content_filter: reverse(CONTENT_FILTERS)[g.explicitContentFilter],
    afk_timeout: g.afkTimeout,
    system_channel_flags: flagsOut,
    preferred_locale: g.preferredLocale,
    premium_progress_bar: g.premiumProgressBarEnabled,
  };
  // Unset channel settings and a disabled Community feature are left out
  // rather than exported as null/false: applying the blueprint elsewhere should
  // not clear another server's settings or switch Community off.
  const channelSettings = {
    afk_channel: g.afkChannelId,
    system_channel: g.systemChannelId,
    rules_channel: g.rulesChannelId,
    public_updates_channel: g.publicUpdatesChannelId,
    safety_alerts_channel: g.safetyAlertsChannelId,
  };
  for (const [k, v] of Object.entries(channelSettings)) if (v) settings[k] = chRef(v);
  if (g.features.includes('COMMUNITY')) settings.community = true;
  notes.push(
    'The server name, icon and description are not exported, so the blueprint can be applied to other servers.',
  );

  const bp: Record<string, unknown> = {
    version: 1,
    name: g.name,
    settings,
    everyone: { permissions: permissionNames(s.roles.find((r) => r.id === guildId)?.permissions ?? 0n) },
    roles: roleOut,
    categories: categoriesOut,
    channels: topLevel,
  };

  if (input.automodRules) {
    const presets = reverse(AUTOMOD_PRESETS);
    const rules = input.automodRules
      .filter((r) => [1, 3, 4, 5].includes(r.triggerType))
      .map((r) => {
        const m = r.triggerMetadata;
        const trigger =
          r.triggerType === 1
            ? {
                type: 'keyword',
                keywords: m.keyword_filter ?? [],
                regex_patterns: m.regex_patterns ?? [],
                allow_list: m.allow_list ?? [],
              }
            : r.triggerType === 3
              ? { type: 'spam' }
              : r.triggerType === 4
                ? {
                    type: 'keyword_preset',
                    presets: (m.presets ?? []).map((p) => presets[p]).filter(Boolean),
                    allow_list: m.allow_list ?? [],
                  }
                : {
                    type: 'mention_spam',
                    mention_total_limit: m.mention_total_limit ?? 5,
                    raid_protection: m.mention_raid_protection_enabled ?? false,
                  };
        const actions = r.actions
          .map((a) =>
            a.type === 1
              ? {
                  type: 'block_message',
                  ...(a.metadata?.custom_message ? { custom_message: a.metadata.custom_message } : {}),
                }
              : a.type === 2 && a.metadata?.channel_id
                ? { type: 'alert', channel: chRef(a.metadata.channel_id) }
                : a.type === 3 && a.metadata?.duration_seconds
                  ? { type: 'timeout', duration_seconds: a.metadata.duration_seconds }
                  : null,
          )
          .filter(Boolean);
        return {
          key: keys.key('automod', r.id, r.name, 'automod'),
          name: r.name,
          enabled: r.enabled,
          trigger,
          actions,
          exempt_roles: r.exemptRoles.map(roleRef),
          exempt_channels: r.exemptChannels.map((id) => chRef(id)),
        };
      });
    const other = input.automodRules.length - rules.length;
    if (other > 0)
      notes.push(
        `${other} AutoMod rule(s) of unsupported trigger types (for example member profile rules) were not exported`,
      );
    if (rules.length > 0) bp.automod = rules;
  } else {
    notes.push('AutoMod rules were not exported: the bot needs Manage Server to read them');
  }

  const messages = input.managedMessages
    .filter((m) => m.message)
    .map((m) => ({
      key: m.key,
      channel: chRef(m.channelId),
      ...(m.message!.content ? { content: m.message!.content } : {}),
      ...(m.message!.embeds.length ? { embeds: m.message!.embeds.map(embedOut) } : {}),
    }));
  const missing = input.managedMessages.filter((m) => !m.message);
  if (missing.length > 0)
    notes.push(
      `managed message(s) no longer on Discord were left out: ${missing.map((m) => m.key).join(', ')}`,
    );
  if (messages.length > 0) bp.messages = messages;

  if (input.welcome) {
    const w = input.welcome;
    bp.welcome = {
      enabled: w.enabled,
      ...(w.channelId ? { channel: chRef(w.channelId) } : {}),
      ...(w.message ? { message: w.message } : {}),
      join_roles: w.joinRoleIds.map(roleRef),
    };
  }
  if (input.selfRoles.length > 0 || input.panels.length > 0) {
    bp.self_roles = {
      roles: input.selfRoles.map(roleRef),
      panels: input.panels.map((p) => ({
        key: p.key,
        channel: chRef(p.channelId),
        title: p.title,
        ...(p.description ? { description: p.description } : {}),
        mode: p.mode,
        options: p.options.map((o) => ({
          role: roleRef(o.roleId),
          label: o.label,
          ...(o.emoji ? { emoji: o.emoji } : {}),
          ...(o.style ? { style: o.style } : {}),
        })),
      })),
    };
  }
  return { blueprint: bp, keys: keys.assigned, notes };
}
