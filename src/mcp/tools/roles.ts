import { z } from 'zod';
import {
  assessRolePrivilege,
  botStanding,
  canBotManageRole,
  has,
  P,
  permissionNames,
  permissionsFromNames,
  roleById,
  rolesTopDown,
} from '../../discord/permissions.js';
import type { RoleWriteBody } from '../../discord/types.js';
import { colorSchema, parseColor } from '../../features/messages.js';
import { runOperation } from '../../ops/journal.js';
import { rolePositionUpdates } from '../../ops/ordering.js';
import { StewardError } from '../../util/errors.js';
import { KEY_RE } from '../../blueprint/schema.js';
import { defineTool } from '../registry.js';
import {
  guildIdInput,
  idOf,
  mutate,
  opContext,
  permissionNamesInput,
  reasonInput,
  requireFound,
  snapshotOf,
  snowflake,
  withGuildLock,
} from './common.js';

export const roleTools = [
  defineTool({
    name: 'create_role',
    title: 'Create role',
    description:
      'Create a role. It lands at the bottom of the role list; pass place_below_role_id (or use reorder_roles) to position it. The bot cannot grant permissions it does not hold. Set staff: true to protect it from ever being self-assigned.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      name: z.string().min(1).max(100),
      color: colorSchema.optional(),
      hoist: z.boolean().optional().describe('Show members separately in the member list.'),
      mentionable: z.boolean().optional(),
      permissions: permissionNamesInput.optional(),
      place_below_role_id: snowflake.optional().describe('Move the new role directly below this role.'),
      staff: z.boolean().optional(),
      key: z.string().regex(KEY_RE).optional().describe('Optional blueprint key to bind the new role to.'),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const bot = botStanding(s);
      if (!has(bot.permissions, P.ManageRoles))
        throw new StewardError('precondition_failed', 'the bot lacks Manage Roles');
      const perms = a.permissions ? permissionsFromNames(a.permissions) : 0n;
      const missing = bot.isAdmin ? 0n : perms & ~bot.permissions;
      if (missing)
        throw new StewardError(
          'precondition_failed',
          `the bot cannot grant permissions it does not hold: ${permissionNames(missing).join(', ')}`,
        );
      const anchor = a.place_below_role_id
        ? requireFound(roleById(s, a.place_below_role_id), `role ${a.place_below_role_id}`)
        : null;
      if (anchor && anchor.position > bot.highestPosition) {
        throw new StewardError(
          'precondition_failed',
          `cannot place a role below "${anchor.name}": it is above the bot's highest role`,
        );
      }
      if (a.key && call.app.store.getMapping(a.guild_id, 'role', a.key))
        throw new StewardError('conflict', `key "${a.key}" is already bound`);
      const body: RoleWriteBody = {
        name: a.name,
        permissions: perms.toString(),
        ...(a.color !== undefined ? { color: parseColor(a.color) } : {}),
        ...(a.hoist !== undefined ? { hoist: a.hoist } : {}),
        ...(a.mentionable !== undefined ? { mentionable: a.mentionable } : {}),
      };
      return withGuildLock(call, a.guild_id, async () => {
        const ctx = opContext(call, a.guild_id, a.reason);
        const out = await runOperation(ctx, {
          action: 'create_role',
          resourceKind: 'role',
          resourceKey: a.key,
          summary: `create role ${a.name}`,
          idempotent: false,
          match: { kind: 'role', name: a.name },
          run: (reason) => call.app.adapter.createRole(a.guild_id, body, reason),
          resultId: (r) => r.id,
        });
        const id = idOf(out, (r) => r.id);
        if (a.key) call.app.store.setMapping(a.guild_id, 'role', a.key, id, 'manual');
        if (a.staff) call.app.store.addProtectedRole(a.guild_id, id);
        let moved: string | undefined;
        if (anchor) {
          // Insert the new role directly under the anchor; the roles in between
          // shift down one slot each, and nothing outside that range moves.
          const fresh = await call.app.adapter.fetchSnapshot(a.guild_id);
          const order = rolesTopDown(fresh).map((r) => r.id);
          const from = order.indexOf(anchor.id);
          const to = order.indexOf(id);
          if (from >= 0 && to > from + 1) {
            const between = order.slice(from + 1, to);
            const updates = rolePositionUpdates(fresh, [anchor.id, id, ...between]);
            if (updates.length) {
              const o = await runOperation(ctx, {
                action: 'reorder_roles',
                resourceKind: 'role',
                targetId: id,
                summary: `place role ${a.name} below ${anchor.name}`,
                idempotent: true,
                run: (reason) => call.app.adapter.setRolePositions(a.guild_id, updates, reason),
              });
              moved = o.opId;
            }
          }
        }
        return {
          op_id: out.opId,
          role_id: id,
          status: out.status,
          position_op_id: moved,
          protected: a.staff ?? false,
        };
      });
    },
  }),

  defineTool({
    name: 'update_role',
    title: 'Update role',
    description:
      "Change a role's name, colour, hoist, mentionable flag or full permission set. Fails early, with the reason, if the role is at or above the bot.",
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      role_id: snowflake,
      name: z.string().min(1).max(100).optional(),
      color: colorSchema.optional(),
      hoist: z.boolean().optional(),
      mentionable: z.boolean().optional(),
      permissions: permissionNamesInput.optional().describe('The complete new permission set (not a delta).'),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const role = requireFound(roleById(s, a.role_id), `role ${a.role_id}`);
      const verdict = canBotManageRole(s, role, 'edit');
      if (!verdict.ok)
        throw new StewardError('precondition_failed', `cannot edit "${role.name}": ${verdict.reason}`);
      const body: RoleWriteBody = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.color !== undefined) body.color = parseColor(a.color);
      if (a.hoist !== undefined) body.hoist = a.hoist;
      if (a.mentionable !== undefined) body.mentionable = a.mentionable;
      if (a.permissions) {
        const perms = permissionsFromNames(a.permissions);
        const bot = botStanding(s);
        const added = perms & ~role.permissions;
        const missing = bot.isAdmin ? 0n : added & ~bot.permissions;
        if (missing)
          throw new StewardError(
            'precondition_failed',
            `the bot cannot grant permissions it does not hold: ${permissionNames(missing).join(', ')}`,
          );
        body.permissions = perms.toString();
      }
      if (Object.keys(body).length === 0) throw new StewardError('invalid_argument', 'nothing to change');
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'update_role',
        resourceKind: 'role',
        targetId: role.id,
        summary: `update role ${role.name}: ${Object.keys(body).join(', ')}`,
        idempotent: true,
        run: (reason) => call.app.adapter.editRole(a.guild_id, role.id, body, reason),
      });
      return { op_id: out.opId, role_id: role.id, changed: Object.keys(body) };
    },
  }),

  defineTool({
    name: 'reorder_roles',
    title: 'Reorder roles',
    description:
      'Put the given roles in this order, top first. Only these roles move, into the slots they already occupy; roles not listed keep their places. Every listed role must be below the bot.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      role_ids: z.array(snowflake).min(2).max(100),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      for (const id of a.role_ids) {
        const r = requireFound(roleById(s, id), `role ${id}`);
        const v = canBotManageRole(s, r, 'move');
        if (!v.ok) throw new StewardError('precondition_failed', `cannot move "${r.name}": ${v.reason}`);
      }
      const updates = rolePositionUpdates(s, a.role_ids);
      if (updates.length === 0) return { changed: 0, note: 'already in that order' };
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'reorder_roles',
        resourceKind: 'role',
        summary: `reorder ${a.role_ids.length} roles`,
        idempotent: true,
        run: (reason) => call.app.adapter.setRolePositions(a.guild_id, updates, reason),
      });
      return { op_id: out.opId, changed: updates.length };
    },
  }),

  defineTool({
    name: 'assign_roles',
    title: 'Add or remove member roles',
    description:
      'Add and remove roles for up to 50 members in one call. Every change is checked against the hierarchy first; nothing is sent if any role cannot be managed. Granting a privileged role (moderation/admin power) requires allow_privileged: true.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      changes: z
        .array(
          z.object({
            user_id: snowflake,
            add: z.array(snowflake).max(25).default([]),
            remove: z.array(snowflake).max(25).default([]),
          }),
        )
        .min(1)
        .max(50),
      allow_privileged: z.boolean().default(false),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const prot = new Set(call.app.store.listProtectedRoles(a.guild_id));
      const problems: string[] = [];
      for (const c of a.changes) {
        for (const id of [...c.add, ...c.remove]) {
          const r = roleById(s, id);
          if (!r) {
            problems.push(`role ${id} not found`);
            continue;
          }
          const v = canBotManageRole(s, r, 'assign');
          if (!v.ok) problems.push(`"${r.name}": ${v.reason}`);
        }
        for (const id of c.add) {
          const r = roleById(s, id);
          if (!r || a.allow_privileged) continue;
          const p = assessRolePrivilege(s, r, prot);
          if (p.privileged)
            problems.push(
              `"${r.name}" is privileged (${p.reasons.join('; ')}); pass allow_privileged: true if this is intended`,
            );
        }
      }
      if (problems.length)
        throw new StewardError('precondition_failed', 'no changes were made', {
          problems: [...new Set(problems)],
        });
      return withGuildLock(call, a.guild_id, async () => {
        const ctx = opContext(call, a.guild_id, a.reason);
        const results: Array<{
          user_id: string;
          role_id: string;
          action: 'add' | 'remove';
          status: string;
          op_id?: string;
          error?: string;
        }> = [];
        for (const c of a.changes) {
          for (const [action, ids] of [
            ['add', c.add],
            ['remove', c.remove],
          ] as const) {
            for (const roleId of ids) {
              try {
                const out = await runOperation(ctx, {
                  action: action === 'add' ? 'add_member_role' : 'remove_member_role',
                  resourceKind: 'member',
                  targetId: c.user_id,
                  summary: `${action} role ${roleById(s, roleId)!.name} ${action === 'add' ? 'to' : 'from'} ${c.user_id}`,
                  idempotent: true,
                  run: (reason) =>
                    action === 'add'
                      ? call.app.adapter.addMemberRole(a.guild_id, c.user_id, roleId, reason)
                      : call.app.adapter.removeMemberRole(a.guild_id, c.user_id, roleId, reason),
                });
                results.push({ user_id: c.user_id, role_id: roleId, action, status: 'ok', op_id: out.opId });
              } catch (error) {
                results.push({
                  user_id: c.user_id,
                  role_id: roleId,
                  action,
                  status: 'failed',
                  error: (error as Error).message,
                });
              }
            }
          }
        }
        const failed = results.filter((r) => r.status !== 'ok');
        return { applied: results.length - failed.length, failed: failed.length, results };
      });
    },
  }),

  defineTool({
    name: 'delete_role',
    title: 'Delete role',
    description:
      "Permanently delete a role. confirm_name must equal the role's current name. Managed (integration) roles and roles at or above the bot cannot be deleted.",
    scope: 'destructive',
    input: z.object({
      guild_id: guildIdInput,
      role_id: snowflake,
      confirm_name: z.string().min(1).max(100),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const role = requireFound(roleById(s, a.role_id), `role ${a.role_id}`);
      if (role.name !== a.confirm_name)
        throw new StewardError(
          'precondition_failed',
          `confirm_name "${a.confirm_name}" does not match the role's name "${role.name}"`,
        );
      const v = canBotManageRole(s, role, 'delete');
      if (!v.ok) throw new StewardError('precondition_failed', `cannot delete "${role.name}": ${v.reason}`);
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'delete_role',
        resourceKind: 'role',
        targetId: role.id,
        summary: `delete role ${role.name}`,
        idempotent: true,
        notFoundIsSuccess: true,
        run: (reason) => call.app.adapter.deleteRole(a.guild_id, role.id, reason),
      });
      const { store } = call.app;
      store.deleteMappingById(a.guild_id, 'role', role.id);
      store.removeSelfRole(a.guild_id, role.id);
      store.removeProtectedRole(a.guild_id, role.id);
      return { op_id: out.opId, deleted: role.id, name: role.name };
    },
  }),
];
