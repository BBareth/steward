import type { ButtonPressEvent, DiscordAdapter } from '../discord/adapter.js';
import { assessRolePrivilege, canBotManageRole, roleById } from '../discord/permissions.js';
import type { ActionRow, ButtonComponent, GuildSnapshot, MessageBody } from '../discord/types.js';
import type { Logger } from '../logger.js';
import { runOperation } from '../ops/journal.js';
import type { RolePanelOption, Store } from '../store.js';
import { StewardError } from '../util/errors.js';
import { escapeUserText } from './messages.js';

/**
 * Self-assigned role panels: an embed with one button per role. Pressing a
 * button toggles the role. Every press is checked again against the
 * allowlist and the role's current power, because both can change after the
 * panel was posted.
 */

export const PANEL_PREFIX = 'stw:rp:';

const STYLES = { primary: 1, secondary: 2, success: 3, danger: 4 } as const;

export function panelCustomId(panelId: string, roleId: string): string {
  return `${PANEL_PREFIX}${panelId}:${roleId}`;
}

export function parsePanelCustomId(customId: string): { panelId: string; roleId: string } | null {
  if (!customId.startsWith(PANEL_PREFIX)) return null;
  const [panelId, roleId] = customId.slice(PANEL_PREFIX.length).split(':');
  return panelId && roleId && /^\d{17,20}$/.test(roleId) ? { panelId, roleId } : null;
}

function parseEmoji(emoji: string | undefined): ButtonComponent['emoji'] | undefined {
  if (!emoji) return undefined;
  const custom = /^<a?:(\w{2,32}):(\d{17,20})>$/.exec(emoji);
  if (custom) return { name: custom[1], id: custom[2] };
  return { name: emoji };
}

export interface PanelContent {
  title: string;
  description: string | null;
  mode: 'multiple' | 'single';
  options: RolePanelOption[];
}

export function buildPanelMessage(panelId: string, panel: PanelContent): MessageBody {
  const buttons: ButtonComponent[] = panel.options.map((o) => ({
    type: 2,
    style: STYLES[o.style ?? 'secondary'],
    label: o.label,
    emoji: parseEmoji(o.emoji),
    custom_id: panelCustomId(panelId, o.roleId),
  }));
  const rows: ActionRow[] = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  return {
    embeds: [
      {
        title: panel.title,
        ...(panel.description ? { description: panel.description } : {}),
        footer: {
          text:
            panel.mode === 'single'
              ? 'Press a button to pick a role. You can hold one of these at a time; press it again to remove it.'
              : 'Press a button to add a role; press it again to remove it.',
        },
      },
    ],
    components: rows,
    allowed_mentions: { parse: [] },
  };
}

/** Raise if a role may not be offered for self-assignment. */
export function assertSelfAssignable(
  snapshot: GuildSnapshot,
  roleId: string,
  protectedIds: Set<string>,
): void {
  const role = roleById(snapshot, roleId);
  if (!role) throw new StewardError('not_found', `role ${roleId} does not exist`);
  const privilege = assessRolePrivilege(snapshot, role, protectedIds);
  if (privilege.privileged) {
    throw new StewardError(
      'forbidden',
      `"${role.name}" cannot be self-assignable: ${privilege.reasons.join('; ')}`,
    );
  }
  const verdict = canBotManageRole(snapshot, role, 'assign');
  if (!verdict.ok)
    throw new StewardError(
      'precondition_failed',
      `"${role.name}" cannot be assigned by the bot: ${verdict.reason}`,
    );
}

export interface PanelDeps {
  store: Store;
  adapter: DiscordAdapter;
  logger: Logger;
}

export async function handlePanelButton(deps: PanelDeps, event: ButtonPressEvent): Promise<void> {
  const parsed = parsePanelCustomId(event.customId);
  const panel = parsed ? deps.store.getPanel(parsed.panelId) : undefined;
  if (!parsed || !panel || panel.guildId !== event.guildId) {
    await event.reply('This panel is no longer active.');
    return;
  }
  const option = panel.options.find((o) => o.roleId === parsed.roleId);
  if (!option) {
    await event.reply('That role is no longer on this panel.');
    return;
  }
  const allow = new Set(deps.store.listSelfRoles(event.guildId));
  if (!allow.has(option.roleId)) {
    await event.reply('That role is no longer self-assignable.');
    return;
  }
  const snapshot = await deps.adapter.fetchSnapshot(event.guildId);
  const protectedIds = new Set(deps.store.listProtectedRoles(event.guildId));
  try {
    assertSelfAssignable(snapshot, option.roleId, protectedIds);
  } catch (error) {
    deps.logger.warn('refused self-assign', {
      guildId: event.guildId,
      roleId: option.roleId,
      reason: (error as Error).message,
    });
    await event.reply(
      "That role can't be self-assigned right now. A moderator has been told via the bot's logs.",
    );
    return;
  }
  const label = escapeUserText(option.label);
  const ctx = {
    store: deps.store,
    adapter: deps.adapter,
    logger: deps.logger,
    guildId: event.guildId,
    planId: null,
    stepId: null,
    tool: 'role_panel',
    clientId: `discord:${event.userId}`,
  };
  if (event.memberRoleIds.includes(option.roleId)) {
    await runOperation(ctx, {
      action: 'remove_member_role',
      resourceKind: 'member',
      targetId: event.userId,
      summary: `role panel ${panel.key}: remove role ${option.roleId} from ${event.userId}`,
      idempotent: true,
      run: (reason) => deps.adapter.removeMemberRole(event.guildId, event.userId, option.roleId, reason),
    });
    await event.reply(`Removed **${label}**.`);
    return;
  }
  if (panel.mode === 'single') {
    for (const other of panel.options) {
      if (
        other.roleId === option.roleId ||
        !event.memberRoleIds.includes(other.roleId) ||
        !allow.has(other.roleId)
      )
        continue;
      const role = roleById(snapshot, other.roleId);
      if (!role || !canBotManageRole(snapshot, role, 'assign').ok) continue;
      await runOperation(ctx, {
        action: 'remove_member_role',
        resourceKind: 'member',
        targetId: event.userId,
        summary: `role panel ${panel.key}: swap out role ${other.roleId} for ${event.userId}`,
        idempotent: true,
        run: (reason) => deps.adapter.removeMemberRole(event.guildId, event.userId, other.roleId, reason),
      });
    }
  }
  await runOperation(ctx, {
    action: 'add_member_role',
    resourceKind: 'member',
    targetId: event.userId,
    summary: `role panel ${panel.key}: add role ${option.roleId} to ${event.userId}`,
    idempotent: true,
    run: (reason) => deps.adapter.addMemberRole(event.guildId, event.userId, option.roleId, reason),
  });
  await event.reply(`Added **${label}**.`);
}
