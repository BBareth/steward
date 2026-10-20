import type { DiscordAdapter, MemberJoinEvent } from '../discord/adapter.js';
import { assessRolePrivilege, canBotManageRole, roleById } from '../discord/permissions.js';
import type { Logger } from '../logger.js';
import { runOperation } from '../ops/journal.js';
import type { Store } from '../store.js';
import type { MessageContent } from './messages.js';
import { buildMessageBody, renderWelcome } from './messages.js';

/**
 * Join handling: give the configured join roles, then post the welcome
 * message. Join roles are re-checked on every join; a role that became
 * privileged since it was configured is skipped and logged, not granted.
 */
export async function handleMemberJoin(
  deps: { store: Store; adapter: DiscordAdapter; logger: Logger },
  event: MemberJoinEvent,
): Promise<{ rolesAdded: string[]; rolesSkipped: string[]; posted: boolean }> {
  const out = { rolesAdded: [] as string[], rolesSkipped: [] as string[], posted: false };
  const cfg = deps.store.getWelcome(event.guildId);
  if (!cfg?.enabled || event.member.isBot) return out;
  const log = deps.logger.child({ guildId: event.guildId, feature: 'welcome' });
  const snapshot = await deps.adapter.fetchSnapshot(event.guildId);
  const protectedIds = new Set(deps.store.listProtectedRoles(event.guildId));
  const ctx = {
    store: deps.store,
    adapter: deps.adapter,
    logger: deps.logger,
    guildId: event.guildId,
    planId: null,
    stepId: null,
    tool: 'welcome',
    clientId: 'discord:join',
  };

  for (const roleId of cfg.joinRoleIds) {
    const role = roleById(snapshot, roleId);
    const privileged = role ? assessRolePrivilege(snapshot, role, protectedIds) : null;
    const verdict = role
      ? canBotManageRole(snapshot, role, 'assign')
      : { ok: false, reason: 'role no longer exists' };
    if (!role || privileged?.privileged || !verdict.ok) {
      log.warn('join role skipped', { roleId, reason: privileged?.reasons.join('; ') || verdict.reason });
      out.rolesSkipped.push(roleId);
      continue;
    }
    try {
      await runOperation(ctx, {
        action: 'add_member_role',
        resourceKind: 'member',
        targetId: event.member.userId,
        summary: `join role ${role.name} for new member ${event.member.userId}`,
        idempotent: true,
        run: (reason) => deps.adapter.addMemberRole(event.guildId, event.member.userId, roleId, reason),
      });
      out.rolesAdded.push(roleId);
    } catch (error) {
      log.warn('join role failed', { roleId, error });
      out.rolesSkipped.push(roleId);
    }
  }

  if (cfg.channelId && cfg.message) {
    const content = renderWelcome(cfg.message as MessageContent, {
      userId: event.member.userId,
      username: event.member.username,
      serverName: snapshot.guild.name,
      memberCount: snapshot.guild.approximateMemberCount,
    });
    const body = buildMessageBody(content, { users: [event.member.userId] });
    try {
      await runOperation(ctx, {
        action: 'post_message',
        resourceKind: 'message',
        targetId: cfg.channelId,
        summary: `welcome message for ${event.member.userId}`,
        idempotent: true,
        run: (_reason, opId) =>
          deps.adapter.sendMessage(cfg.channelId!, {
            ...body,
            nonce: opId.slice(0, 25),
            enforce_nonce: true,
          }),
        resultId: (m) => m.id,
      });
      out.posted = true;
    } catch (error) {
      log.warn('welcome message failed', { error });
    }
  }
  return out;
}
