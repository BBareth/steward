import type { Blueprint, BlueprintCategory, BlueprintChannel, BlueprintOverwrite } from './schema.js';
import {
  AUTOMOD_PRESETS,
  CONTENT_FILTERS,
  NOTIFICATION_LEVELS,
  SYSTEM_CHANNEL_FLAGS,
  VERIFICATION_LEVELS,
} from './schema.js';
import type {
  AutoModFields,
  Change,
  ChannelFields,
  OverwriteRef,
  PanelFields,
  PlanBody,
  PlanIssue,
  PlanOptions,
  PlanStep,
  RoleFields,
  SettingsFields,
} from './plan-types.js';
import type { RefString } from './refs.js';
import { channelRef, describeRef, refKey, roleRef } from './refs.js';
import {
  assessRolePrivilege,
  botChannelPermissions,
  botStanding,
  canBotManageRole,
  has,
  P,
  permissionNames,
  permissionsFromNames,
  rolesTopDown,
} from '../discord/permissions.js';
import type { AutoModRuleInfo, ChannelInfo, ChannelKind, GuildSnapshot, RoleInfo } from '../discord/types.js';
import { CHANNEL_TYPE_NUMBERS } from '../discord/types.js';
import type { OverwriteSpec } from '../features/access.js';
import { expandAccess, mergeOverwrites } from '../features/access.js';
import { buildMessageBody, parseColor } from '../features/messages.js';
import type { ManagedMessage, Mapping, MappingKind, RolePanel, WelcomeConfig } from '../store.js';
import { StewardError } from '../util/errors.js';
import { hashValue, stableStringify } from '../util/hash.js';

export interface PlannerInput {
  blueprint: Blueprint;
  blueprintHash: string;
  snapshot: GuildSnapshot;
  mappings: Mapping[];
  /** null when the bot cannot read AutoMod rules (no Manage Server) and the blueprint has none. */
  automodRules: AutoModRuleInfo[] | null;
  managedMessages: Array<ManagedMessage & { exists: boolean }>;
  panels: Array<RolePanel & { messageExists: boolean }>;
  welcome: WelcomeConfig | undefined;
  selfRoles: string[];
  protectedRoles: string[];
  membersIntent: boolean;
  options: PlanOptions;
}

const TEXT_GROUP = new Set<ChannelKind>(['text', 'announcement', 'forum', 'media']);
const COMMUNITY_TYPES = new Set(['announcement', 'stage']);
const BITRATE_LIMITS = [96000, 128000, 256000, 384000];

const groupOf = (kind: ChannelKind | string): 'category' | 'text' | 'voice' =>
  kind === 'category' ? 'category' : TEXT_GROUP.has(kind as ChannelKind) ? 'text' : 'voice';

const sortChannels = (a: ChannelInfo, b: ChannelInfo) =>
  a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NewStep = DistributiveOmit<PlanStep, 'id'>;

interface ChannelEntry {
  key: string;
  name: string;
  kind: ChannelKind;
  spec: BlueprintChannel | null;
  category: BlueprintCategory | null;
  categorySpec: BlueprintCategory | null;
}

/**
 * Compute what it would take to make the server match the blueprint. Pure:
 * reads the inputs, writes nothing. The executor turns the result into
 * Discord requests later, resolving keys through the mapping table.
 */
export function computePlan(input: PlannerInput): PlanBody {
  return new Planner(input).run();
}

class Planner {
  private steps: PlanStep[] = [];
  private warnings: PlanIssue[] = [];
  private unsupported: PlanIssue[] = [];
  private unchanged = 0;
  private seq = 0;
  private readonly bp: Blueprint;
  private readonly snap: GuildSnapshot;
  private readonly guildId: string;
  private readonly bot;
  /** key → existing Discord ID, or null for resources this plan creates. */
  private readonly ids: Record<MappingKind, Map<string, string | null>> = {
    role: new Map(),
    channel: new Map(),
    automod: new Map(),
  };
  /** key → id of the step that creates it. */
  private readonly creators: Record<MappingKind, Map<string, string>> = {
    role: new Map(),
    channel: new Map(),
    automod: new Map(),
  };
  /** Keys that cannot exist after this plan (unsupported or unresolvable). */
  private readonly unavailable = new Set<string>();
  private readonly claimed = new Set<string>();
  private readonly mappingByKey = new Map<string, Mapping>();
  private readonly mappedIds = new Set<string>();
  private readonly entries: ChannelEntry[] = [];
  private settingsStepId: string | null = null;
  private selfRolesStepId: string | null = null;
  private readonly communityEnabled: boolean;

  constructor(private readonly input: PlannerInput) {
    this.bp = input.blueprint;
    this.snap = input.snapshot;
    this.guildId = this.snap.guild.id;
    this.bot = botStanding(this.snap);
    for (const m of input.mappings) {
      this.mappingByKey.set(`${m.kind}:${m.key}`, m);
      this.mappedIds.add(`${m.kind}:${m.discordId}`);
    }
    this.communityEnabled = this.snap.guild.features.includes('COMMUNITY');
    for (const cat of this.bp.categories) {
      this.entries.push({
        key: cat.key,
        name: cat.name,
        kind: 'category',
        spec: null,
        category: null,
        categorySpec: cat,
      });
      for (const ch of cat.channels) {
        this.entries.push({
          key: ch.key,
          name: ch.name,
          kind: ch.type,
          spec: ch,
          category: cat,
          categorySpec: null,
        });
      }
    }
    for (const ch of this.bp.channels) {
      this.entries.push({
        key: ch.key,
        name: ch.name,
        kind: ch.type,
        spec: ch,
        category: null,
        categorySpec: null,
      });
    }
  }

  run(): PlanBody {
    this.resolveRoles();
    this.resolveChannels();
    this.resolveAutomod();
    this.planRoles();
    this.planRoleOrder();
    this.planChannels('category');
    this.planChannels('channel');
    this.planSettings();
    this.planChannels('community');
    this.planChannelOrder();
    this.planAutomod();
    this.planMessages();
    this.planWelcome();
    this.planSelfRoles();
    this.planPanels();
    this.planDeletions();
    this.propagateBlocked();

    const count = (pred: (s: PlanStep) => boolean) => this.steps.filter(pred).length;
    const resolution: Record<string, string> = {};
    for (const kind of ['role', 'channel', 'automod'] as const) {
      for (const [key, id] of this.ids[kind]) resolution[`${kind}:${key}`] = id ?? '(new)';
    }
    return {
      guildId: this.guildId,
      guildName: this.snap.guild.name,
      blueprintName: this.bp.name ?? null,
      blueprintHash: this.input.blueprintHash,
      options: this.input.options,
      summary: {
        create: count((s) => s.action.startsWith('create_') || s.action.startsWith('post_')),
        update: count(
          (s) =>
            s.action.startsWith('update_') ||
            s.action.startsWith('edit_') ||
            s.action === 'set_overwrites' ||
            s.action === 'configure_welcome' ||
            s.action === 'set_self_roles',
        ),
        delete: count((s) => s.action.startsWith('delete_')),
        reorder: count((s) => s.action.startsWith('reorder_')),
        other: count((s) => s.action === 'adopt'),
        unchanged: this.unchanged,
        blocked: count((s) => !!s.blocked),
        unsupported: this.unsupported.length,
        warnings: this.warnings.length,
      },
      steps: this.steps,
      unsupported: this.unsupported,
      warnings: this.warnings,
      readsAutomod: this.input.automodRules !== null,
      resolution,
    };
  }

  // ---- helpers ------------------------------------------------------------------

  private add(step: NewStep): string {
    const id = `s${++this.seq}`;
    this.steps.push({ ...step, id } as PlanStep);
    return id;
  }

  private warn(code: string, message: string, ref?: string) {
    this.warnings.push({ code, message, ref });
  }

  private role(id: string): RoleInfo | undefined {
    return this.snap.roles.find((r) => r.id === id);
  }

  private channel(id: string): ChannelInfo | undefined {
    return this.snap.channels.find((c) => c.id === id);
  }

  /** Current Discord ID for a ref, `null` if it will be created by this plan, `undefined` if unknown. */
  private resolve(ref: RefString, kind: MappingKind): string | null | undefined {
    if (ref === 'everyone') return this.guildId;
    if (ref.startsWith('id:') || ref.startsWith('member:')) return ref.slice(ref.indexOf(':') + 1);
    const key = refKey(ref)!;
    return this.ids[kind].get(key);
  }

  /** Step dependencies for refs, and a block reason if any ref cannot exist. */
  private deps(refs: Array<{ ref: RefString | null; kind: MappingKind }>): {
    dependsOn: string[];
    blocked?: string;
  } {
    const dependsOn: string[] = [];
    for (const { ref, kind } of refs) {
      if (!ref) continue;
      const key = refKey(ref);
      if (!key) {
        if (ref.startsWith('id:')) {
          const id = ref.slice(3);
          const exists = kind === 'role' ? this.role(id) : kind === 'channel' ? this.channel(id) : true;
          if (!exists) return { dependsOn, blocked: `${kind} ${id} does not exist in this server` };
        }
        continue;
      }
      if (this.unavailable.has(`${kind}:${key}`))
        return { dependsOn, blocked: `${kind} "${key}" will not exist` };
      const creator = this.creators[kind].get(key);
      if (creator) dependsOn.push(creator);
    }
    return { dependsOn: [...new Set(dependsOn)] };
  }

  /**
   * Find the Discord resource a blueprint entry refers to: its mapping, an
   * explicit `id`, or (only when asked) a unique unmapped resource with the
   * same name.
   */
  private bind(
    kind: MappingKind,
    key: string,
    explicitId: string | undefined,
    name: string,
    exists: (id: string) => boolean,
    candidatesByName: () => string[],
    describe: string,
  ): string | null | undefined {
    const mapping = this.mappingByKey.get(`${kind}:${key}`);
    if (explicitId) {
      if (!exists(explicitId)) {
        throw new StewardError(
          'precondition_failed',
          `${describe} "${key}" names id ${explicitId}, which does not exist in this server`,
        );
      }
      if (this.claimed.has(`${kind}:${explicitId}`)) {
        throw new StewardError(
          'precondition_failed',
          `${describe} id ${explicitId} is claimed by two blueprint entries`,
        );
      }
      this.claimed.add(`${kind}:${explicitId}`);
      if (mapping?.discordId !== explicitId) {
        this.add({
          action: 'adopt',
          kind,
          key,
          discordId: explicitId,
          summary: `bind ${describe} "${key}" to existing ${explicitId}`,
          destructive: false,
          dependsOn: [],
        });
      }
      return explicitId;
    }
    if (mapping) {
      if (exists(mapping.discordId)) {
        this.claimed.add(`${kind}:${mapping.discordId}`);
        return mapping.discordId;
      }
      this.warn(
        'mapped_resource_missing',
        `${describe} "${key}" was ${mapping.discordId}, which no longer exists (deleted outside steward?); it will be created again`,
        key,
      );
    }
    const sameName = candidatesByName().filter(
      (id) => !this.mappedIds.has(`${kind}:${id}`) && !this.claimed.has(`${kind}:${id}`),
    );
    if (this.input.options.adopt_by_name && sameName.length === 1) {
      const id = sameName[0]!;
      this.claimed.add(`${kind}:${id}`);
      this.add({
        action: 'adopt',
        kind,
        key,
        discordId: id,
        summary: `adopt existing ${describe} "${name}" (${id}) as "${key}"`,
        destructive: false,
        dependsOn: [],
      });
      return id;
    }
    if (sameName.length > 0) {
      if (this.input.options.adopt_by_name) {
        this.unavailable.add(`${kind}:${key}`);
        this.unsupported.push({
          code: 'ambiguous_adoption',
          message: `${sameName.length} unmanaged ${describe}s are named "${name}"; add "id:" to the blueprint entry "${key}" to choose one`,
          ref: key,
        });
        return undefined;
      }
      this.warn(
        'name_collision',
        `an unmanaged ${describe} named "${name}" already exists (${sameName.join(', ')}); a new one will be created. To manage the existing one, add "id: ${sameName[0]}" to "${key}" or plan with adopt_by_name`,
        key,
      );
    }
    return null;
  }

  // ---- resolution -----------------------------------------------------------------

  private resolveRoles() {
    for (const r of this.bp.roles) {
      const id = this.bind(
        'role',
        r.key,
        r.id,
        r.name,
        (id) => !!this.role(id),
        () =>
          this.snap.roles
            .filter((x) => x.name === r.name && x.id !== this.guildId && !x.managed)
            .map((x) => x.id),
        'role',
      );
      if (id !== undefined) this.ids.role.set(r.key, id);
      if (id) {
        const role = this.role(id)!;
        if (role.id === this.guildId)
          throw new StewardError(
            'precondition_failed',
            `role "${r.key}" is bound to @everyone; use the "everyone" section`,
          );
        if (role.managed) {
          throw new StewardError(
            'precondition_failed',
            `role "${r.key}" is bound to "${role.name}", which is managed by an integration and cannot be managed by a blueprint`,
          );
        }
      }
    }
  }

  private resolveChannels() {
    for (const e of this.entries) {
      const kindOk = (c: ChannelInfo) =>
        e.kind === 'category'
          ? c.kind === 'category'
          : c.kind === e.kind ||
            (c.kind === 'text' && e.kind === 'announcement') ||
            (c.kind === 'announcement' && e.kind === 'text');
      const explicit = e.spec?.id ?? e.categorySpec?.id;
      const id = this.bind(
        'channel',
        e.key,
        explicit,
        e.name,
        (id) => !!this.channel(id),
        () => this.snap.channels.filter((c) => c.name === e.name && kindOk(c)).map((c) => c.id),
        e.kind === 'category' ? 'category' : 'channel',
      );
      if (id !== undefined) this.ids.channel.set(e.key, id);
      if (id) {
        const c = this.channel(id)!;
        if ((e.kind === 'category') !== (c.kind === 'category')) {
          throw new StewardError(
            'precondition_failed',
            `"${e.key}" is bound to #${c.name}, which is ${c.kind === 'category' ? 'a category' : 'not a category'}`,
          );
        }
      }
    }
  }

  private resolveAutomod() {
    const rules = this.input.automodRules ?? [];
    for (const a of this.bp.automod) {
      const id = this.bind(
        'automod',
        a.key,
        undefined,
        a.name,
        (id) => rules.some((r) => r.id === id),
        () => rules.filter((r) => r.name === a.name).map((r) => r.id),
        'AutoMod rule',
      );
      if (id !== undefined) this.ids.automod.set(a.key, id);
    }
  }

  // ---- roles --------------------------------------------------------------------

  private planRoles() {
    const canManageRoles = has(this.bot.permissions, P.ManageRoles);
    for (const r of this.bp.roles) {
      if (!this.ids.role.has(r.key)) continue;
      const id = this.ids.role.get(r.key)!;
      const fields: RoleFields = { name: r.name };
      if (r.color !== undefined) fields.color = parseColor(r.color);
      if (r.hoist !== undefined) fields.hoist = r.hoist;
      if (r.mentionable !== undefined) fields.mentionable = r.mentionable;
      const perms = r.permissions ? permissionsFromNames(r.permissions) : undefined;
      if (perms !== undefined) fields.permissions = perms.toString();

      if (id === null) {
        const ungrantable = perms !== undefined && !this.bot.isAdmin ? perms & ~this.bot.permissions : 0n;
        const stepId = this.add({
          action: 'create_role',
          key: r.key,
          fields,
          summary: `create role "${r.name}"${perms !== undefined ? ` with ${permissionNames(perms).length} permission(s)` : ''}`,
          destructive: false,
          dependsOn: [],
          blocked: !canManageRoles
            ? 'the bot lacks Manage Roles'
            : ungrantable
              ? `the bot cannot grant permissions it does not hold: ${permissionNames(ungrantable).join(', ')}`
              : undefined,
        });
        this.creators.role.set(r.key, stepId);
        continue;
      }
      const role = this.role(id)!;
      const changes: Change[] = [];
      const changed: RoleFields = {};
      if (role.name !== r.name) {
        changes.push({ field: 'name', from: role.name, to: r.name });
        changed.name = r.name;
      }
      if (fields.color !== undefined && role.color !== fields.color) {
        changes.push({ field: 'color', from: role.color, to: fields.color });
        changed.color = fields.color;
      }
      if (fields.hoist !== undefined && role.hoist !== fields.hoist) {
        changes.push({ field: 'hoist', from: role.hoist, to: fields.hoist });
        changed.hoist = fields.hoist;
      }
      if (fields.mentionable !== undefined && role.mentionable !== fields.mentionable) {
        changes.push({ field: 'mentionable', from: role.mentionable, to: fields.mentionable });
        changed.mentionable = fields.mentionable;
      }
      let added = 0n;
      if (perms !== undefined && role.permissions !== perms) {
        added = perms & ~role.permissions;
        changes.push({
          field: 'permissions',
          from: { removed: permissionNames(role.permissions & ~perms) },
          to: { added: permissionNames(added) },
        });
        changed.permissions = perms.toString();
      }
      if (changes.length === 0) {
        this.unchanged++;
        continue;
      }
      const verdict = canBotManageRole(this.snap, role, 'edit');
      const ungrantable = !this.bot.isAdmin ? added & ~this.bot.permissions : 0n;
      this.add({
        action: 'update_role',
        key: r.key,
        roleId: id,
        fields: changed,
        changes,
        summary: `update role "${role.name}": ${changes.map((c) => c.field).join(', ')}`,
        destructive: false,
        dependsOn: [],
        blocked: !verdict.ok
          ? verdict.reason
          : ungrantable
            ? `the bot cannot grant permissions it does not hold: ${permissionNames(ungrantable).join(', ')}`
            : undefined,
      });
    }

    if (this.bp.everyone) {
      const everyone = this.role(this.guildId)!;
      const perms = permissionsFromNames(this.bp.everyone.permissions);
      if (everyone.permissions !== perms) {
        const added = perms & ~everyone.permissions;
        const ungrantable = !this.bot.isAdmin ? added & ~this.bot.permissions : 0n;
        this.add({
          action: 'update_role',
          key: 'everyone',
          roleId: this.guildId,
          fields: { permissions: perms.toString() },
          changes: [
            {
              field: 'permissions',
              from: { removed: permissionNames(everyone.permissions & ~perms) },
              to: { added: permissionNames(added) },
            },
          ],
          summary: '@everyone: update permissions',
          destructive: false,
          dependsOn: [],
          blocked: !canManageRoles
            ? 'the bot lacks Manage Roles'
            : ungrantable
              ? `the bot cannot grant permissions it does not hold: ${permissionNames(ungrantable).join(', ')}`
              : undefined,
        });
      } else {
        this.unchanged++;
      }
    }
  }

  private planRoleOrder() {
    const movable: string[] = [];
    let anyNew = false;
    for (const r of this.bp.roles) {
      if (!this.ids.role.has(r.key)) continue;
      const id = this.ids.role.get(r.key);
      if (id === null) {
        movable.push(r.key);
        anyNew = true;
        continue;
      }
      const verdict = canBotManageRole(this.snap, this.role(id!)!, 'move');
      if (verdict.ok) movable.push(r.key);
      else this.warn('role_not_movable', `role "${r.key}" will keep its position: ${verdict.reason}`, r.key);
    }
    if (movable.length < 2) return;
    const existing = movable.map((k) => this.ids.role.get(k)).filter((id): id is string => !!id);
    const current = rolesTopDown(this.snap)
      .map((r) => r.id)
      .filter((id) => existing.includes(id));
    if (!anyNew && stableStringify(current) === stableStringify(existing)) return;
    const { dependsOn } = this.deps(movable.map((k) => ({ ref: `key:${k}`, kind: 'role' as const })));
    this.add({
      action: 'reorder_roles',
      order: movable,
      summary: `order roles top to bottom: ${movable.join(' > ')}`,
      destructive: false,
      dependsOn,
      blocked: has(this.bot.permissions, P.ManageRoles) ? undefined : 'the bot lacks Manage Roles',
    });
  }

  // ---- channels -----------------------------------------------------------------

  private overwriteSpecs(
    list: BlueprintOverwrite[] | undefined,
    access: BlueprintChannel['access'],
    kind: ChannelKind,
  ): OverwriteSpec[] | null {
    if (!list && !access) return null;
    const explicit: OverwriteSpec[] = (list ?? []).map((o) => ({
      target: o.role !== undefined ? roleRef(o.role) : `member:${o.member}`,
      type: o.role !== undefined ? 'role' : 'member',
      allow: permissionsFromNames(o.allow),
      deny: permissionsFromNames(o.deny),
    }));
    const preset = access
      ? expandAccess(
          {
            private: access.private,
            read_only: access.read_only,
            visible_to: access.visible_to?.map(roleRef),
            writers: access.writers?.map(roleRef),
          },
          kind,
        ).map((o) => ({ ...o, target: o.target === 'everyone' ? 'everyone' : o.target }))
      : [];
    return this.withBotAccess(mergeOverwrites(preset, explicit), kind);
  }

  /**
   * A bot without Administrator that hides a channel from @everyone hides it
   * from itself too, and then cannot manage it. Give it an explicit way in.
   */
  private withBotAccess(specs: OverwriteSpec[], kind: ChannelKind): OverwriteSpec[] {
    if (this.bot.isAdmin) return specs;
    const everyone = specs.find((s) => s.target === 'everyone');
    if (!everyone || (everyone.deny & P.ViewChannel) === 0n) return specs;
    const botRole = this.snap.roles.find((r) => r.managed && r.tags?.botId === this.bot.userId);
    const target = botRole ? `id:${botRole.id}` : `member:${this.bot.userId}`;
    const wanted =
      (P.ViewChannel |
        P.ManageChannels |
        P.ManageRoles |
        P.ReadMessageHistory |
        P.SendMessages |
        P.EmbedLinks |
        (kind === 'voice' || kind === 'stage' ? P.Connect : 0n)) &
      this.bot.permissions;
    const existing = specs.find((s) => s.target === target);
    if (existing) {
      existing.allow |= wanted;
      existing.deny &= ~wanted;
      return specs;
    }
    return [...specs, { target, type: botRole ? 'role' : 'member', allow: wanted, deny: 0n }];
  }

  private desiredOverwrites(e: ChannelEntry): OverwriteSpec[] | null {
    if (e.kind === 'category')
      return this.overwriteSpecs(e.categorySpec!.permissions, e.categorySpec!.access, 'category');
    const spec = e.spec!;
    const own = this.overwriteSpecs(spec.permissions, spec.access, e.kind);
    if (own) return own;
    if (e.category && spec.sync_permissions !== false) {
      return this.overwriteSpecs(e.category.permissions, e.category.access, 'category');
    }
    return null;
  }

  private toRefs(specs: OverwriteSpec[]): OverwriteRef[] {
    return specs.map((s) => ({
      target: s.target,
      type: s.type,
      allow: s.allow.toString(),
      deny: s.deny.toString(),
    }));
  }

  private describeOverwrite(o: { allow: bigint; deny: bigint } | undefined) {
    return o ? { allow: permissionNames(o.allow), deny: permissionNames(o.deny) } : null;
  }

  private channelFields(e: ChannelEntry): ChannelFields {
    if (e.kind === 'category') return { name: e.name };
    const s = e.spec!;
    const f: ChannelFields = { name: s.name };
    if (s.topic !== undefined) f.topic = s.topic;
    if (s.nsfw !== undefined) f.nsfw = s.nsfw;
    if (s.slowmode_seconds !== undefined) f.rate_limit_per_user = s.slowmode_seconds;
    if (s.bitrate !== undefined) f.bitrate = s.bitrate;
    if (s.user_limit !== undefined) f.user_limit = s.user_limit;
    return f;
  }

  private overwriteBlock(specs: OverwriteSpec[], channel: ChannelInfo | null): string | undefined {
    if (!has(this.bot.permissions, P.ManageRoles)) return 'setting channel permissions needs Manage Roles';
    if (this.bot.isAdmin) return undefined;
    const held = channel ? botChannelPermissions(this.snap, channel) : this.bot.permissions;
    const bits = specs.reduce((a, s) => a | s.allow | s.deny, 0n);
    const missing = bits & ~held;
    return missing
      ? `the bot can only allow or deny permissions it holds; missing ${permissionNames(missing).join(', ')}`
      : undefined;
  }

  private planChannels(phase: 'category' | 'channel' | 'community') {
    const canManage = has(this.bot.permissions, P.ManageChannels);
    for (const e of this.entries) {
      if ((phase === 'category') !== (e.kind === 'category')) continue;
      if (!this.ids.channel.has(e.key)) continue;
      const id = this.ids.channel.get(e.key)!;
      const needsCommunity = COMMUNITY_TYPES.has(e.kind) && !this.communityEnabled;
      const enablingCommunity = this.bp.settings?.community === true;
      // Creating an announcement/stage channel, or converting a text channel
      // into one, has to wait until the settings step has turned Community on.
      const converting = id !== null && e.kind !== 'category' && this.channel(id)?.kind !== e.kind;
      const afterSettings = needsCommunity && enablingCommunity && (id === null || converting);
      if (phase === 'channel' && afterSettings) continue;
      if (phase === 'community' && !afterSettings) continue;
      const settingsDep = phase === 'community' && this.settingsStepId ? [this.settingsStepId] : [];

      const parentRef = e.category ? channelRef(e.category.key) : null;
      const specs = this.desiredOverwrites(e);
      const fields = this.channelFields(e);
      const parentDeps = this.deps([{ ref: parentRef, kind: 'channel' }]);
      const overwriteDeps = this.deps(
        (specs ?? []).filter((s) => s.type === 'role').map((s) => ({ ref: s.target, kind: 'role' as const })),
      );

      if (id === null) {
        if (needsCommunity && !enablingCommunity) {
          this.unavailable.add(`channel:${e.key}`);
          this.unsupported.push({
            code: 'needs_community',
            message: `${e.kind} channel "${e.key}" needs the Community feature; enable it in Server Settings or set settings.community: true`,
            ref: e.key,
          });
          continue;
        }
        const tier = this.snap.guild.premiumTier;
        const bitrateLimit = BITRATE_LIMITS[tier] ?? 96000;
        const dependsOn = [...parentDeps.dependsOn, ...overwriteDeps.dependsOn];
        dependsOn.push(...settingsDep);
        const stepId = this.add({
          action: 'create_channel',
          key: e.key,
          fields: { ...fields, type: CHANNEL_TYPE_NUMBERS[e.kind as keyof typeof CHANNEL_TYPE_NUMBERS] },
          parent: parentRef,
          overwrites: this.toRefs(specs ?? []),
          summary: `create ${e.kind} ${e.kind === 'category' ? `"${e.name}"` : `#${e.name}`}${e.category ? ` in "${e.category.name}"` : ''}${specs ? ` with ${specs.length} permission overwrite(s)` : ''}`,
          destructive: false,
          dependsOn,
          blocked:
            parentDeps.blocked ??
            overwriteDeps.blocked ??
            (!canManage
              ? 'the bot lacks Manage Channels'
              : specs?.length
                ? this.overwriteBlock(specs, null)
                : fields.bitrate && fields.bitrate > bitrateLimit
                  ? `bitrate ${fields.bitrate} exceeds this server's limit of ${bitrateLimit}`
                  : undefined),
        });
        this.creators.channel.set(e.key, stepId);
        continue;
      }

      const ch = this.channel(id)!;
      const changes: Change[] = [];
      const changed: ChannelFields = {};
      const cmp = <K extends keyof ChannelFields>(field: K, current: ChannelFields[K]) => {
        const want = fields[field];
        if (want === undefined) return;
        const norm = (v: unknown) => (v === '' ? null : v);
        if (norm(current) !== norm(want)) {
          changes.push({ field, from: current, to: want });
          changed[field] = want;
        }
      };
      cmp('name', ch.name);
      cmp('topic', ch.topic);
      cmp('nsfw', ch.nsfw);
      cmp('rate_limit_per_user', ch.rateLimitPerUser);
      cmp('bitrate', ch.bitrate ?? undefined);
      cmp('user_limit', ch.userLimit ?? undefined);
      if (e.kind !== 'category' && ch.kind !== e.kind) {
        if (
          (ch.kind === 'text' && e.kind === 'announcement') ||
          (ch.kind === 'announcement' && e.kind === 'text')
        ) {
          if (this.communityEnabled || enablingCommunity) {
            changes.push({ field: 'type', from: ch.kind, to: e.kind });
            changed.type = CHANNEL_TYPE_NUMBERS[e.kind as keyof typeof CHANNEL_TYPE_NUMBERS];
          } else {
            this.unsupported.push({
              code: 'needs_community',
              message: `#${ch.name} cannot become an announcement channel without the Community feature`,
              ref: e.key,
            });
          }
        } else {
          this.unsupported.push({
            code: 'type_change',
            message: `#${ch.name} is a ${ch.kind} channel; Discord cannot convert it to ${e.kind}. Delete it (prune) or give the blueprint entry a new key`,
            ref: e.key,
          });
        }
      }
      let parentChange: RefString | null | undefined;
      if (e.kind !== 'category') {
        const wantParent = parentRef ? this.resolve(parentRef, 'channel') : null;
        if (wantParent === null && parentRef) {
          parentChange = parentRef;
        } else if ((wantParent ?? null) !== ch.parentId) {
          parentChange = parentRef;
        }
        if (parentChange !== undefined) {
          changes.push({
            field: 'parent',
            from: ch.parentId ? `#${this.channel(ch.parentId)?.name ?? ch.parentId}` : null,
            to: parentRef ? describeRef(parentRef) : null,
          });
        }
      }
      const channelPerms = botChannelPermissions(this.snap, ch);
      const fieldBlock = has(channelPerms, P.ManageChannels)
        ? undefined
        : `the bot lacks Manage Channels in #${ch.name}`;
      if (changes.length > 0) {
        this.add({
          action: 'update_channel',
          key: e.key,
          channelId: id,
          fields: changed,
          ...(parentChange !== undefined ? { parent: parentChange } : {}),
          changes,
          summary: `update ${e.kind === 'category' ? 'category' : '#'}${ch.name}: ${changes.map((c) => c.field).join(', ')}`,
          destructive: false,
          dependsOn: [...parentDeps.dependsOn, ...settingsDep],
          blocked: parentDeps.blocked ?? fieldBlock,
        });
      }

      let overwritesChanged = false;
      if (specs) {
        const put: OverwriteRef[] = [];
        const remove: string[] = [];
        const owChanges: Change[] = [];
        const desiredIds = new Set<string>();
        for (const s of specs) {
          const targetId = this.resolve(s.target, 'role');
          if (targetId) desiredIds.add(targetId);
          const cur = targetId ? ch.overwrites.find((o) => o.id === targetId) : undefined;
          const same = cur
            ? cur.allow === s.allow && cur.deny === s.deny
            : targetId && s.allow === 0n && s.deny === 0n;
          if (!same) {
            put.push(...this.toRefs([s]));
            owChanges.push({
              field: `overwrite ${describeRef(s.target)}`,
              from: this.describeOverwrite(cur),
              to: this.describeOverwrite(s),
            });
          }
        }
        const extra = ch.overwrites.filter((o) => !desiredIds.has(o.id));
        if (extra.length > 0) {
          if (this.input.options.prune.overwrites) {
            for (const o of extra) {
              remove.push(o.id);
              owChanges.push({
                field: `overwrite ${o.type} ${this.role(o.id)?.name ?? o.id}`,
                from: this.describeOverwrite(o),
                to: null,
              });
            }
          } else {
            const isPrivate = specs.some((s) => s.target === 'everyone' && (s.deny & P.ViewChannel) !== 0n);
            const leaks = extra.filter((o) => (o.allow & P.ViewChannel) !== 0n);
            if (isPrivate && leaks.length > 0) {
              this.warn(
                'private_channel_exposed',
                `#${ch.name} is meant to be private, but ${leaks.length} overwrite(s) not in the blueprint grant View Channel (${leaks.map((o) => (o.type === 'role' ? `role ${this.role(o.id)?.name ?? o.id}` : `member ${o.id}`)).join(', ')}); plan with prune.overwrites to remove them`,
                e.key,
              );
            } else {
              this.warn(
                'unmanaged_overwrites',
                `#${ch.name} keeps ${extra.length} overwrite(s) that are not in the blueprint`,
                e.key,
              );
            }
          }
        }
        if (put.length > 0 || remove.length > 0) {
          overwritesChanged = true;
          this.add({
            action: 'set_overwrites',
            key: e.key,
            channelId: id,
            put,
            remove,
            changes: owChanges,
            summary: `set ${put.length} and remove ${remove.length} permission overwrite(s) on ${e.kind === 'category' ? 'category ' : '#'}${ch.name}`,
            destructive: remove.length > 0,
            dependsOn: overwriteDeps.dependsOn,
            blocked: overwriteDeps.blocked ?? this.overwriteBlock(specs, ch),
          });
        }
      }
      if (changes.length === 0 && !overwritesChanged) this.unchanged++;
    }
  }

  private planChannelOrder() {
    const buckets: Array<{ parent: RefString | null; group: 'category' | 'text' | 'voice'; keys: string[] }> =
      [];
    buckets.push({ parent: null, group: 'category', keys: this.bp.categories.map((c) => c.key) });
    const split = (parent: RefString | null, list: BlueprintChannel[]) => {
      buckets.push({
        parent,
        group: 'text',
        keys: list.filter((c) => groupOf(c.type) === 'text').map((c) => c.key),
      });
      buckets.push({
        parent,
        group: 'voice',
        keys: list.filter((c) => groupOf(c.type) === 'voice').map((c) => c.key),
      });
    };
    split(null, this.bp.channels);
    for (const cat of this.bp.categories) split(channelRef(cat.key), cat.channels);

    for (const b of buckets) {
      const keys = b.keys.filter((k) => this.ids.channel.has(k) && !this.unavailable.has(`channel:${k}`));
      if (keys.length < 2) continue;
      const parentId = b.parent ? this.resolve(b.parent, 'channel') : null;
      let needs = parentId === null && b.parent !== null;
      const existing: string[] = [];
      for (const k of keys) {
        const id = this.ids.channel.get(k);
        if (!id) {
          needs = true;
          continue;
        }
        if ((this.channel(id)!.parentId ?? null) !== (parentId ?? null)) needs = true;
        existing.push(id);
      }
      if (!needs) {
        const current = this.snap.channels
          .filter((c) => existing.includes(c.id))
          .sort(sortChannels)
          .map((c) => c.id);
        needs = stableStringify(current) !== stableStringify(existing);
      }
      if (!needs) continue;
      const { dependsOn, blocked } = this.deps([
        { ref: b.parent, kind: 'channel' },
        ...keys.map((k) => ({ ref: `key:${k}`, kind: 'channel' as const })),
      ]);
      // Moves into the bucket must happen first.
      for (const s of this.steps) {
        if (s.action === 'update_channel' && s.parent !== undefined && keys.includes(s.key))
          dependsOn.push(s.id);
      }
      this.add({
        action: 'reorder_channels',
        parent: b.parent,
        group: b.group,
        order: keys,
        summary: `order ${b.group === 'category' ? 'categories' : `${b.group} channels`}${b.parent ? ` in ${describeRef(b.parent)}` : b.group === 'category' ? '' : ' outside categories'}: ${keys.join(', ')}`,
        destructive: false,
        dependsOn: [...new Set(dependsOn)],
        blocked:
          blocked ??
          (has(this.bot.permissions, P.ManageChannels) ? undefined : 'the bot lacks Manage Channels'),
      });
    }
  }

  // ---- settings -----------------------------------------------------------------

  private planSettings() {
    const s = this.bp.settings;
    if (!s) return;
    const g = this.snap.guild;
    const fields: SettingsFields = {};
    const changes: Change[] = [];
    const refs: Array<{ ref: RefString | null; kind: MappingKind }> = [];
    const set = <K extends keyof SettingsFields>(
      field: K,
      want: SettingsFields[K] | undefined,
      current: unknown,
      shown?: unknown,
    ) => {
      if (want === undefined) return;
      if (want !== current) {
        fields[field] = want;
        changes.push({ field, from: current, to: shown ?? want });
      }
    };
    set('name', s.name, g.name);
    set('description', s.description, g.description);
    set(
      'verification_level',
      s.verification_level !== undefined ? VERIFICATION_LEVELS[s.verification_level] : undefined,
      g.verificationLevel,
      s.verification_level,
    );
    set(
      'default_message_notifications',
      s.default_notifications !== undefined ? NOTIFICATION_LEVELS[s.default_notifications] : undefined,
      g.defaultMessageNotifications,
      s.default_notifications,
    );
    set(
      'explicit_content_filter',
      s.explicit_content_filter !== undefined ? CONTENT_FILTERS[s.explicit_content_filter] : undefined,
      g.explicitContentFilter,
      s.explicit_content_filter,
    );
    set('afk_timeout', s.afk_timeout, g.afkTimeout);
    set('preferred_locale', s.preferred_locale, g.preferredLocale);
    set('premium_progress_bar_enabled', s.premium_progress_bar, g.premiumProgressBarEnabled);
    if (s.system_channel_flags) {
      let flags = g.systemChannelFlags;
      for (const [name, bit] of Object.entries(SYSTEM_CHANNEL_FLAGS)) {
        const want = s.system_channel_flags[name as keyof typeof SYSTEM_CHANNEL_FLAGS];
        if (want === true) flags |= bit;
        if (want === false) flags &= ~bit;
      }
      set('system_channel_flags', flags, g.systemChannelFlags);
    }
    const channelSetting = (
      field:
        | 'afk_channel'
        | 'system_channel'
        | 'rules_channel'
        | 'public_updates_channel'
        | 'safety_alerts_channel',
      value: string | null | undefined,
      current: string | null,
    ) => {
      if (value === undefined) return;
      if (value === null) {
        if (current !== null) {
          fields[field] = null;
          changes.push({ field, from: current, to: null });
        }
        return;
      }
      const ref = channelRef(value);
      refs.push({ ref, kind: 'channel' });
      const id = this.resolve(ref, 'channel');
      // A channel this plan creates has no id yet, so it is always a change.
      if (!id || id !== current) {
        fields[field] = ref;
        changes.push({
          field,
          from: current ? `#${this.channel(current)?.name ?? current}` : null,
          to: describeRef(ref),
        });
      }
    };
    channelSetting('afk_channel', s.afk_channel, g.afkChannelId);
    channelSetting('system_channel', s.system_channel, g.systemChannelId);
    channelSetting('rules_channel', s.rules_channel, g.rulesChannelId);
    channelSetting('public_updates_channel', s.public_updates_channel, g.publicUpdatesChannelId);
    channelSetting('safety_alerts_channel', s.safety_alerts_channel, g.safetyAlertsChannelId);
    if (s.community !== undefined && s.community !== this.communityEnabled) {
      fields.community = s.community;
      changes.push({ field: 'community', from: this.communityEnabled, to: s.community });
    }
    if (changes.length === 0) {
      this.unchanged++;
      return;
    }
    const { dependsOn, blocked } = this.deps(refs);
    this.settingsStepId = this.add({
      action: 'update_settings',
      fields,
      changes,
      summary: `update server settings: ${changes.map((c) => c.field).join(', ')}`,
      destructive: false,
      dependsOn,
      blocked:
        blocked ?? (has(this.bot.permissions, P.ManageGuild) ? undefined : 'the bot lacks Manage Server'),
    });
  }

  // ---- automod ------------------------------------------------------------------

  private automodFields(a: Blueprint['automod'][number]): AutoModFields {
    const t = a.trigger;
    let trigger_type: number;
    let trigger_metadata: Record<string, unknown>;
    switch (t.type) {
      case 'keyword':
        trigger_type = 1;
        trigger_metadata = {
          keyword_filter: t.keywords,
          regex_patterns: t.regex_patterns,
          allow_list: t.allow_list,
        };
        break;
      case 'spam':
        trigger_type = 3;
        trigger_metadata = {};
        break;
      case 'keyword_preset':
        trigger_type = 4;
        trigger_metadata = { presets: t.presets.map((p) => AUTOMOD_PRESETS[p]), allow_list: t.allow_list };
        break;
      case 'mention_spam':
        trigger_type = 5;
        trigger_metadata = {
          mention_total_limit: t.mention_total_limit,
          mention_raid_protection_enabled: t.raid_protection,
        };
        break;
    }
    return {
      name: a.name,
      enabled: a.enabled,
      trigger_type,
      trigger_metadata,
      actions: a.actions.map((act) =>
        act.type === 'block_message'
          ? { type: 1, ...(act.custom_message ? { custom_message: act.custom_message } : {}) }
          : act.type === 'alert'
            ? { type: 2, channel: channelRef(act.channel) }
            : { type: 3, duration_seconds: act.duration_seconds },
      ),
      exempt_roles: a.exempt_roles.map(roleRef),
      exempt_channels: a.exempt_channels.map(channelRef),
    };
  }

  /** Comparable form of a rule; refs that point at not-yet-created resources never compare equal. */
  private automodComparable(f: AutoModFields): string | null {
    let unresolved = false;
    const r = (ref: RefString, kind: MappingKind) => {
      const id = this.resolve(ref, kind);
      if (!id) unresolved = true;
      return id ?? '?';
    };
    const sorted = (v: unknown) => (Array.isArray(v) ? [...v].map(String).sort() : v);
    const meta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f.trigger_metadata)) {
      if (Array.isArray(v) && v.length === 0) continue;
      meta[k] = sorted(v);
    }
    const value = {
      name: f.name,
      enabled: f.enabled,
      trigger_type: f.trigger_type,
      meta,
      actions: f.actions.map((a) => ({
        type: a.type,
        channel: a.channel ? r(a.channel, 'channel') : undefined,
        duration_seconds: a.duration_seconds,
        custom_message: a.custom_message,
      })),
      exempt_roles: f.exempt_roles.map((x) => r(x, 'role')).sort(),
      exempt_channels: f.exempt_channels.map((x) => r(x, 'channel')).sort(),
    };
    return unresolved ? null : stableStringify(value);
  }

  private ruleComparable(rule: AutoModRuleInfo): string {
    const sorted = (v: unknown) => (Array.isArray(v) ? [...v].map(String).sort() : v);
    const meta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rule.triggerMetadata)) {
      if (v === undefined || (Array.isArray(v) && v.length === 0)) continue;
      if (rule.triggerType === 5 && k === 'mention_raid_protection_enabled' && v === false) {
        meta[k] = false;
        continue;
      }
      meta[k] = sorted(v);
    }
    return stableStringify({
      name: rule.name,
      enabled: rule.enabled,
      trigger_type: rule.triggerType,
      meta,
      actions: rule.actions.map((a) => ({
        type: a.type,
        channel: a.metadata?.channel_id,
        duration_seconds: a.metadata?.duration_seconds,
        custom_message: a.metadata?.custom_message || undefined,
      })),
      exempt_roles: [...rule.exemptRoles].sort(),
      exempt_channels: [...rule.exemptChannels].sort(),
    });
  }

  private planAutomod() {
    if (this.bp.automod.length === 0) return;
    const canManage = has(this.bot.permissions, P.ManageGuild);
    const rules = this.input.automodRules ?? [];
    const limits: Record<number, number> = { 1: 6, 3: 1, 4: 1, 5: 1 };
    const counts: Record<number, number> = {};
    for (const r of rules) counts[r.triggerType] = (counts[r.triggerType] ?? 0) + 1;
    for (const a of this.bp.automod) {
      if (!this.ids.automod.has(a.key)) continue;
      const id = this.ids.automod.get(a.key)!;
      const fields = this.automodFields(a);
      const refs = [
        ...fields.actions
          .filter((x) => x.channel)
          .map((x) => ({ ref: x.channel!, kind: 'channel' as const })),
        ...fields.exempt_roles.map((ref) => ({ ref, kind: 'role' as const })),
        ...fields.exempt_channels.map((ref) => ({ ref, kind: 'channel' as const })),
      ];
      const { dependsOn, blocked } = this.deps(refs);
      if (id === null) {
        counts[fields.trigger_type] = (counts[fields.trigger_type] ?? 0) + 1;
        const over = counts[fields.trigger_type]! > limits[fields.trigger_type]!;
        const stepId = this.add({
          action: 'create_automod',
          key: a.key,
          fields,
          summary: `create AutoMod rule "${a.name}" (${a.trigger.type})`,
          destructive: false,
          dependsOn,
          blocked:
            blocked ??
            (!canManage
              ? 'AutoMod needs Manage Server'
              : over
                ? `the server already has the maximum number of ${a.trigger.type} rules (${limits[fields.trigger_type]}); prune or remove one first`
                : undefined),
        });
        this.creators.automod.set(a.key, stepId);
        continue;
      }
      const rule = rules.find((r) => r.id === id)!;
      if (rule.triggerType !== fields.trigger_type) {
        this.unsupported.push({
          code: 'automod_trigger_change',
          message: `AutoMod rule "${rule.name}" cannot change its trigger type; delete it and create a new one`,
          ref: a.key,
        });
        continue;
      }
      const want = this.automodComparable(fields);
      if (want !== null && want === this.ruleComparable(rule)) {
        this.unchanged++;
        continue;
      }
      this.add({
        action: 'update_automod',
        key: a.key,
        ruleId: id,
        fields,
        changes: [{ field: 'rule', from: rule.name, to: a.name }],
        summary: `update AutoMod rule "${rule.name}"`,
        destructive: false,
        dependsOn,
        blocked: blocked ?? (canManage ? undefined : 'AutoMod needs Manage Server'),
      });
    }
  }

  // ---- messages, welcome, self roles, panels -------------------------------------

  private sendBlock(ref: RefString, embeds: boolean): string | undefined {
    const id = this.resolve(ref, 'channel');
    if (!id) return undefined;
    const ch = this.channel(id);
    if (!ch) return `channel ${id} does not exist`;
    const perms = botChannelPermissions(this.snap, ch);
    if (!has(perms, P.ViewChannel | P.SendMessages)) return `the bot cannot post in #${ch.name}`;
    if (embeds && !has(perms, P.EmbedLinks)) return `the bot lacks Embed Links in #${ch.name}`;
    return undefined;
  }

  private planMessages() {
    for (const m of this.bp.messages) {
      const content = { content: m.content, embeds: m.embeds };
      const payloadHash = hashValue(buildMessageBody(content));
      const ref = channelRef(m.channel);
      const channelId = this.resolve(ref, 'channel');
      const rec = this.input.managedMessages.find((x) => x.key === m.key);
      const { dependsOn, blocked } = this.deps([{ ref, kind: 'channel' }]);
      const block = blocked ?? this.sendBlock(ref, !!m.embeds?.length);
      if (rec && rec.exists && channelId && rec.channelId === channelId) {
        if (rec.payloadHash === payloadHash) {
          this.unchanged++;
          continue;
        }
        this.add({
          action: 'edit_message',
          key: m.key,
          channelId: rec.channelId,
          messageId: rec.messageId,
          content,
          payloadHash,
          summary: `edit message "${m.key}"`,
          destructive: false,
          dependsOn,
          blocked: block,
        });
        continue;
      }
      if (rec && !rec.exists)
        this.warn(
          'message_missing',
          `message "${m.key}" was deleted outside steward; it will be posted again`,
          m.key,
        );
      this.add({
        action: 'post_message',
        key: m.key,
        channel: ref,
        content,
        payloadHash,
        ...(rec && rec.exists ? { replaces: { channelId: rec.channelId, messageId: rec.messageId } } : {}),
        summary: `post message "${m.key}" in ${describeRef(ref)}${rec && rec.exists ? ' (moving it from its old channel)' : ''}`,
        destructive: false,
        dependsOn,
        blocked: block,
      });
    }
  }

  private assignBlock(ref: RefString, purpose: string, protectedIds: Set<string>): string | undefined {
    const id = this.resolve(ref, 'role');
    if (!id) return undefined;
    const role = this.role(id);
    if (!role) return `role ${id} does not exist`;
    const verdict = canBotManageRole(this.snap, role, 'assign');
    if (!verdict.ok) return `cannot use "${role.name}" for ${purpose}: ${verdict.reason}`;
    const privilege = assessRolePrivilege(this.snap, role, protectedIds);
    if (privilege.privileged)
      return `"${role.name}" is privileged and cannot be used for ${purpose}: ${privilege.reasons.join('; ')}`;
    return undefined;
  }

  private protectedIds(): Set<string> {
    const ids = new Set(this.input.protectedRoles);
    for (const r of this.bp.roles) {
      const id = this.ids.role.get(r.key);
      if (r.staff && id) ids.add(id);
    }
    return ids;
  }

  private planWelcome() {
    const w = this.bp.welcome;
    if (!w) return;
    const channel = w.channel ? channelRef(w.channel) : null;
    const joinRoles = w.join_roles.map(roleRef);
    const message = w.message ?? null;
    const cur = this.input.welcome;
    const channelId = channel ? this.resolve(channel, 'channel') : null;
    const roleIds = joinRoles.map((r) => this.resolve(r, 'role'));
    const same =
      cur &&
      cur.enabled === w.enabled &&
      (channel === null ? cur.channelId === null : channelId !== null && channelId === cur.channelId) &&
      stableStringify(cur.message) === stableStringify(message) &&
      roleIds.every((id) => !!id) &&
      stableStringify([...cur.joinRoleIds].sort()) === stableStringify([...(roleIds as string[])].sort());
    if (!this.input.membersIntent && w.enabled) {
      this.warn(
        'members_intent_disabled',
        'welcome messages and join roles only run with DISCORD_MEMBERS_INTENT=true (and Server Members Intent enabled in the developer portal)',
      );
    }
    if (same) {
      this.unchanged++;
      return;
    }
    const prot = this.protectedIds();
    const { dependsOn, blocked } = this.deps([
      { ref: channel, kind: 'channel' },
      ...joinRoles.map((ref) => ({ ref, kind: 'role' as const })),
    ]);
    const block =
      blocked ??
      joinRoles.map((r) => this.assignBlock(r, 'join roles', prot)).find(Boolean) ??
      (channel ? this.sendBlock(channel, !!message?.embeds?.length) : undefined);
    this.add({
      action: 'configure_welcome',
      enabled: w.enabled,
      channel,
      message,
      joinRoles,
      summary: `configure welcome: ${w.enabled ? 'on' : 'off'}${channel ? `, posts in ${describeRef(channel)}` : ''}${joinRoles.length ? `, gives ${joinRoles.map(describeRef).join(', ')}` : ''}`,
      destructive: false,
      dependsOn,
      blocked: block,
    });
  }

  private planSelfRoles() {
    const staff = this.bp.roles.filter((r) => r.staff).map((r) => roleRef(r.key));
    const sr = this.bp.self_roles;
    if (!sr && staff.length === 0) return;
    const roles = sr ? sr.roles.map(roleRef) : null;
    const prot = this.protectedIds();
    const roleIds = (roles ?? []).map((r) => this.resolve(r, 'role'));
    const staffIds = staff.map((r) => this.resolve(r, 'role'));
    const currentAllow = new Set(this.input.selfRoles);
    const currentProtected = new Set(this.input.protectedRoles);
    const allowSame =
      roles === null ||
      (roleIds.every((id) => !!id) &&
        roleIds.length === currentAllow.size &&
        roleIds.every((id) => currentAllow.has(id!)));
    const protSame = staffIds.every((id) => !!id && currentProtected.has(id));
    if (allowSame && protSame) {
      this.unchanged++;
      return;
    }
    const { dependsOn, blocked } = this.deps(
      [...(roles ?? []), ...staff].map((ref) => ({ ref, kind: 'role' as const })),
    );
    const block =
      blocked ?? (roles ?? []).map((r) => this.assignBlock(r, 'self-assignment', prot)).find(Boolean);
    this.selfRolesStepId = this.add({
      action: 'set_self_roles',
      roles,
      protect: staff,
      summary: `${roles ? `set self-assignable roles to ${roles.map(describeRef).join(', ') || 'none'}` : 'keep self-assignable roles'}${staff.length ? `; protect staff roles ${staff.map(describeRef).join(', ')}` : ''}`,
      destructive: false,
      dependsOn,
      blocked: block,
    });
  }

  private panelFields(p: NonNullable<Blueprint['self_roles']>['panels'][number]): PanelFields {
    return {
      channel: channelRef(p.channel),
      title: p.title,
      description: p.description ?? null,
      mode: p.mode,
      options: p.options.map((o) => ({
        role: roleRef(o.role),
        label: o.label,
        emoji: o.emoji,
        style: o.style,
      })),
    };
  }

  private planPanels() {
    for (const p of this.bp.self_roles?.panels ?? []) {
      const fields = this.panelFields(p);
      const stored = this.input.panels.find((x) => x.key === p.key);
      const channelId = this.resolve(fields.channel, 'channel');
      const deps = this.deps([
        { ref: fields.channel, kind: 'channel' },
        ...fields.options.map((o) => ({ ref: o.role, kind: 'role' as const })),
      ]);
      const dependsOn = [...deps.dependsOn, ...(this.selfRolesStepId ? [this.selfRolesStepId] : [])];
      const block =
        deps.blocked ??
        this.sendBlock(fields.channel, true) ??
        (has(this.bot.permissions, P.ManageRoles) ? undefined : 'role panels need Manage Roles');
      if (stored && stored.messageId && stored.messageExists && channelId === stored.channelId) {
        const roleIds = fields.options.map((o) => this.resolve(o.role, 'role'));
        const same =
          roleIds.every((id) => !!id) &&
          stableStringify({ t: stored.title, d: stored.description, m: stored.mode, o: stored.options }) ===
            stableStringify({
              t: fields.title,
              d: fields.description,
              m: fields.mode,
              o: fields.options.map((o, i) => ({
                roleId: roleIds[i],
                label: o.label,
                emoji: o.emoji,
                style: o.style,
              })),
            });
        if (same) {
          this.unchanged++;
          continue;
        }
        this.add({
          action: 'edit_panel',
          key: p.key,
          panelId: stored.id,
          channelId: stored.channelId,
          messageId: stored.messageId,
          fields,
          summary: `update role panel "${p.key}"`,
          destructive: false,
          dependsOn,
          blocked: block,
        });
        continue;
      }
      if (stored && stored.messageId && !stored.messageExists)
        this.warn(
          'panel_message_missing',
          `role panel "${p.key}" message was deleted outside steward; it will be posted again`,
          p.key,
        );
      const moving = stored && stored.messageId && stored.messageExists && channelId !== stored.channelId;
      this.add({
        action: 'post_panel',
        key: p.key,
        panelId: stored?.id ?? null,
        fields,
        ...(moving ? { replaces: { channelId: stored!.channelId, messageId: stored!.messageId! } } : {}),
        summary: `post role panel "${p.key}" in ${describeRef(fields.channel)} with ${fields.options.length} button(s)`,
        destructive: false,
        dependsOn,
        blocked: block,
      });
    }
  }

  // ---- deletions ----------------------------------------------------------------

  private planDeletions() {
    const { prune, prune_unmanaged } = this.input.options;
    const inBlueprint = (kind: MappingKind, id: string) => [...this.ids[kind].values()].includes(id);
    const mappedKey = (kind: MappingKind, id: string) =>
      this.input.mappings.find((m) => m.kind === kind && m.discordId === id)?.key ?? null;

    if (prune.messages) {
      const keys = new Set(this.bp.messages.map((m) => m.key));
      for (const m of this.input.managedMessages) {
        if (keys.has(m.key)) continue;
        this.add({
          action: 'delete_message',
          key: m.key,
          channelId: m.channelId,
          messageId: m.messageId,
          summary: `delete message "${m.key}"`,
          destructive: true,
          dependsOn: [],
        });
      }
    }
    if (prune.panels) {
      const keys = new Set((this.bp.self_roles?.panels ?? []).map((p) => p.key));
      for (const p of this.input.panels) {
        if (keys.has(p.key)) continue;
        this.add({
          action: 'delete_panel',
          key: p.key,
          panelId: p.id,
          channelId: p.channelId,
          messageId: p.messageExists ? p.messageId : null,
          summary: `delete role panel "${p.key}"`,
          destructive: true,
          dependsOn: [],
        });
      }
    }
    if (prune.automod && this.input.automodRules) {
      for (const r of this.input.automodRules) {
        if (inBlueprint('automod', r.id)) continue;
        const key = mappedKey('automod', r.id);
        if (!key && !prune_unmanaged) continue;
        this.add({
          action: 'delete_automod',
          key,
          targetId: r.id,
          name: r.name,
          summary: `delete AutoMod rule "${r.name}"${key ? '' : ' (not managed by steward)'}`,
          destructive: true,
          dependsOn: [],
          blocked: has(this.bot.permissions, P.ManageGuild) ? undefined : 'AutoMod needs Manage Server',
        });
      }
    }
    if (prune.channels) {
      const g = this.snap.guild;
      const candidates = this.snap.channels.filter((c) => {
        if (c.kind === 'other' || inBlueprint('channel', c.id)) return false;
        return !!mappedKey('channel', c.id) || prune_unmanaged;
      });
      candidates.sort((a, b) => Number(a.kind === 'category') - Number(b.kind === 'category'));
      for (const c of candidates) {
        const key = mappedKey('channel', c.id);
        const required =
          g.features.includes('COMMUNITY') &&
          (g.rulesChannelId === c.id || g.publicUpdatesChannelId === c.id);
        this.add({
          action: 'delete_channel',
          key,
          targetId: c.id,
          name: c.name,
          summary: `delete ${c.kind === 'category' ? 'category' : `${c.kind} channel`} ${c.kind === 'category' ? `"${c.name}"` : `#${c.name}`}${key ? '' : ' (not managed by steward)'}`,
          destructive: true,
          dependsOn: [],
          blocked: required
            ? `#${c.name} is the Community rules or updates channel; point the setting elsewhere first`
            : has(botChannelPermissions(this.snap, c), P.ManageChannels)
              ? undefined
              : `the bot lacks Manage Channels in #${c.name}`,
        });
      }
    }
    if (prune.roles) {
      const prot = new Set(this.input.protectedRoles);
      for (const r of rolesTopDown(this.snap)) {
        if (r.id === this.guildId || r.managed || inBlueprint('role', r.id)) continue;
        const key = mappedKey('role', r.id);
        if (!key && !prune_unmanaged) continue;
        if (!key && (prot.has(r.id) || this.snap.botMember.roleIds.includes(r.id))) {
          this.warn('protected_role_kept', `role "${r.name}" is protected and was not pruned`, r.id);
          continue;
        }
        const verdict = canBotManageRole(this.snap, r, 'delete');
        this.add({
          action: 'delete_role',
          key,
          targetId: r.id,
          name: r.name,
          summary: `delete role "${r.name}"${key ? '' : ' (not managed by steward)'}`,
          destructive: true,
          dependsOn: [],
          blocked: verdict.ok ? undefined : verdict.reason,
        });
      }
    }
  }

  private propagateBlocked() {
    const byId = new Map(this.steps.map((s) => [s.id, s]));
    for (const s of this.steps) {
      if (s.blocked) continue;
      const dep = s.dependsOn.map((d) => byId.get(d)).find((d) => d?.blocked);
      if (dep) s.blocked = `depends on blocked step ${dep.id} (${dep.summary})`;
    }
  }
}

/** Snapshot fingerprints used to detect that the server changed between plan and apply. */
export function computeFingerprints(input: {
  snapshot: GuildSnapshot;
  mappings: Mapping[];
  automodRules: AutoModRuleInfo[] | null;
  localState: unknown;
}): Record<string, string> {
  const out: Record<string, string> = {};
  const { snapshot: s } = input;
  const g = s.guild;
  out.guild = hashValue({
    name: g.name,
    description: g.description,
    v: g.verificationLevel,
    n: g.defaultMessageNotifications,
    f: g.explicitContentFilter,
    afk: [g.afkChannelId, g.afkTimeout],
    sys: [g.systemChannelId, g.systemChannelFlags],
    rules: g.rulesChannelId,
    updates: g.publicUpdatesChannelId,
    safety: g.safetyAlertsChannelId,
    locale: g.preferredLocale,
    bar: g.premiumProgressBarEnabled,
    features: [...g.features].sort(),
  });
  out.bot = hashValue(s.botMember.roleIds);
  for (const r of s.roles) out[`role:${r.id}`] = hashValue({ ...r });
  for (const c of s.channels) out[`channel:${c.id}`] = hashValue({ ...c });
  if (input.automodRules) for (const r of input.automodRules) out[`automod:${r.id}`] = hashValue(r);
  out.mappings = hashValue(input.mappings.map((m) => [m.kind, m.key, m.discordId]));
  out.local = hashValue(input.localState);
  return out;
}

export function diffFingerprints(
  before: Record<string, string>,
  after: Record<string, string>,
  snapshot: GuildSnapshot,
): string[] {
  const changed: string[] = [];
  const name = (k: string) => {
    const [kind, id] = k.split(':');
    if (kind === 'role') return `role "${snapshot.roles.find((r) => r.id === id)?.name ?? id}"`;
    if (kind === 'channel') return `channel #${snapshot.channels.find((c) => c.id === id)?.name ?? id}`;
    if (kind === 'automod') return `AutoMod rule ${id}`;
    return (
      {
        guild: 'server settings',
        bot: "the bot's roles",
        mappings: 'steward key mappings',
        local: 'welcome/self-role/panel/message configuration',
      }[k] ?? k
    );
  };
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[k] === after[k]) continue;
    if (!(k in before)) changed.push(`${name(k)} was added`);
    else if (!(k in after)) changed.push(`${name(k)} was removed`);
    else changed.push(`${name(k)} changed`);
  }
  return changed;
}
