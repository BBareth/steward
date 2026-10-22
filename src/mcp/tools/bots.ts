import { z } from 'zod';
import {
  basePermissions,
  canBotManageRole,
  channelPermissions,
  compareRoles,
  has,
  P,
  permissionNames,
  permissionsFromNames,
  roleById,
} from '../../discord/permissions.js';
import { StewardError } from '../../util/errors.js';
import { defineTool } from '../registry.js';
import { guildIdInput, permissionNamesInput, snapshotOf, snowflake, untrusted } from './common.js';

export const botTools = [
  defineTool({
    name: 'check_bot_setup',
    title: 'Check a bot setup',
    description:
      'Read-only setup check for steward or another installed bot: membership, required server and channel permissions, and roles it must be able to assign. Reports exact blockers and what steward can reposition. Checks only the requirements you supply; does not prove the bot is online or configured in its own service.',
    scope: 'read',
    input: z.object({
      guild_id: guildIdInput,
      bot_user_id: snowflake.describe('Bot user ID, not an arbitrary application ID.'),
      required_guild_permissions: permissionNamesInput.default([]),
      channels: z
        .array(
          z.object({
            channel_id: snowflake,
            permissions: permissionNamesInput.default(['ViewChannel', 'SendMessages']),
          }),
        )
        .max(50)
        .default([]),
      assignable_role_ids: z
        .array(snowflake)
        .max(50)
        .default([])
        .describe('Roles this bot must be able to grant, for example leveling or reaction roles.'),
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      // Validate permission names even when the bot has not been installed yet.
      const required = permissionsFromNames(a.required_guild_permissions);
      const requestedChannels = a.channels.map((c) => ({
        ...c,
        bits: permissionsFromNames(c.permissions),
      }));
      const s = await snapshotOf(call, a.guild_id);
      const member =
        a.bot_user_id === s.botMember.userId
          ? s.botMember
          : await call.app.adapter.fetchMember(a.guild_id, a.bot_user_id);
      if (!member)
        return {
          installed: false,
          requirements_met: false,
          bot_user_id: a.bot_user_id,
          next_steps: [
            "Use generate_invite_link with the vendor's application ID and its documented permissions. A person with Manage Server must authorise the install, then run this check again.",
          ],
        };
      if (!member.isBot) throw new StewardError('invalid_argument', 'bot_user_id belongs to a human member');

      const subject = { userId: member.userId, roleIds: member.roleIds };
      const permissions = basePermissions(s, subject);
      const roles = s.roles
        .filter((r) => member.roleIds.includes(r.id) || r.id === a.guild_id)
        .sort((x, y) => compareRoles(y, x));
      const top = roles[0];
      const missing = permissionNames(required & ~permissions);
      const channels = [];
      for (const c of requestedChannels) {
        let channel = s.channels.find((x) => x.id === c.channel_id);
        if (!channel) {
          const found = await call.app.adapter.fetchChannel(c.channel_id);
          if (found.status !== 'visible') {
            channels.push({
              channel_id: c.channel_id,
              status: 'unverified' as const,
              requirements_met: false,
              reason:
                found.status === 'hidden'
                  ? "steward cannot inspect this channel. Give steward View Channel, then check again; this says nothing about the other bot's access."
                  : "Discord did not return this channel to steward. Check the ID and steward's access; the other bot's access is unverified.",
            });
            continue;
          }
          if (found.guildId !== a.guild_id)
            throw new StewardError('invalid_argument', 'a requested channel is not in this server');
          channel = found.channel;
        }
        if (channel.kind === 'other') {
          channels.push({
            channel_id: channel.id,
            status: 'unverified' as const,
            requirements_met: false,
            reason:
              'Only guild channels are supported; thread membership and thread permissions are not checked.',
          });
          continue;
        }
        let effective = channelPermissions(s, channel, subject);
        if (['voice', 'stage'].includes(channel.kind) && !has(effective, P.Connect)) {
          effective &= ~(
            P.Speak |
            P.Stream |
            P.UseVAD |
            P.PrioritySpeaker |
            P.RequestToSpeak |
            P.ManageChannels
          );
        }
        const channelMissing = permissionNames(c.bits & ~effective);
        channels.push({
          channel_id: channel.id,
          name: untrusted(channel.name),
          status: 'checked' as const,
          requirements_met: channelMissing.length === 0,
          missing_permissions: channelMissing,
        });
      }
      const assignableRoles = a.assignable_role_ids.map((id) => {
        const role = roleById(s, id);
        const blockers: string[] = [];
        if (!role) blockers.push('role not found in this server');
        else {
          if (id === a.guild_id) blockers.push('@everyone cannot be assigned');
          if (role.managed) blockers.push('integration-managed roles cannot be assigned');
          if (!top || compareRoles(role, top) >= 0)
            blockers.push("role is at or above this bot's highest role; move the bot above it");
        }
        if (!has(permissions, P.ManageRoles)) blockers.push('the bot lacks Manage Roles');
        return {
          role_id: id,
          name: untrusted(role?.name),
          assignable: blockers.length === 0,
          blockers,
        };
      });
      return {
        installed: true,
        bot: {
          user_id: member.userId,
          name: untrusted(member.username),
          highest_role: top ? { id: top.id, name: untrusted(top.name) } : null,
          managed_roles: roles
            .filter((r) => r.tags?.botId === member.userId)
            .map((r) => ({
              id: r.id,
              name: untrusted(r.name),
              steward_can_move: canBotManageRole(s, r, 'move'),
            })),
        },
        requirements_met:
          missing.length === 0 &&
          channels.every((c) => c.requirements_met) &&
          assignableRoles.every((r) => r.assignable),
        missing_guild_permissions: missing,
        channels,
        assignable_roles: assignableRoles,
        warnings: has(permissions, P.Administrator)
          ? [
              "This bot has Administrator, which bypasses channel overwrites. Role hierarchy still applies. Prefer the vendor's documented permissions.",
            ]
          : [],
        limitations: [
          "Only the supplied permission and role requirements were checked. This does not verify the bot's online state, privileged intents, command permissions or vendor settings.",
          "Configure the bot through its own documented API, dashboard or commands. steward cannot invoke another bot's slash commands.",
        ],
        next_steps: [
          "For missing channel permissions, review set_channel_permissions with this bot's member ID or role. For role order, use reorder_roles only below steward's highest role; otherwise the server owner must move the role.",
          'Run check_bot_setup again after changes to verify the same requirements.',
        ],
      };
    },
  }),
];
