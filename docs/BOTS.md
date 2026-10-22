# Setting up other Discord bots

An agent can prepare a server for another bot and verify its permissions with
steward. It does not need the other bot's token. This workflow uses Discord's
[bot authorization](https://docs.discord.com/developers/topics/oauth2#bot-authorization-flow)
and [permission hierarchy](https://docs.discord.com/developers/topics/permissions#permission-hierarchy).

## Agent workflow

1. Read the chosen bot's official documentation. Identify its application ID,
   bot user ID, required permissions, log/command channels, roles it assigns,
   and any configuration API it actually supports. Do not invent dashboard API
   routes or assume a bot can invoke another bot's slash commands.
2. Call `get_guild_overview`. Prepare channels and ordinary roles using a
   blueprint (`validate_blueprint` → `plan_blueprint` → review → `apply_plan` →
   `verify_blueprint`). Keep privileged roles out of self-role allowlists.
3. Call `generate_invite_link` with the vendor's application ID, the target
   `guild_id` and an explicit `permissions` list from its documentation.
   A person with Manage Server reviews and authorises the install. steward's
   default third-party invite preset is only for inspection; it is not a
   universal working configuration for every bot.
4. Call `check_bot_setup` with the bot's **user ID** and the requirements for
   this setup. For example, a bot that posts embeds and grants a reward role:

   ```json
   {
     "guild_id": "123456789012345678",
     "bot_user_id": "234567890123456789",
     "required_guild_permissions": ["ManageRoles"],
     "channels": [
       {
         "channel_id": "345678901234567890",
         "permissions": ["ViewChannel", "SendMessages", "EmbedLinks"]
       }
     ],
     "assignable_role_ids": ["456789012345678901"]
   }
   ```

   All IDs above are placeholders. There are no default server permissions or
   assignable roles; each listed channel defaults to View Channel and Send
   Messages if `permissions` is omitted. At most 50 channels and 50 roles are
   checked per call. Omitting requirements only checks installation.
5. Fix the reported blockers using the existing tools, after reviewing the
   intended changes. `set_channel_permissions` can target a bot member or its
   role. Preserve existing overwrite bits: the tool replaces that target's
   allow/deny values. `reorder_roles` takes roles in top-to-bottom order and
   only moves the listed roles within their current slots, so include the
   roles whose positions must swap. All must be below steward's highest role.
   If they are above steward, the operator must move them in Discord. Managed
   bot roles may be repositioned where Discord permits, but cannot be handed
   out as reward roles. Prefer a dedicated ordinary role for extra permissions.
6. Configure vendor-specific features through the vendor's documented API with
   credentials kept on the homelab, or let the operator finish its dashboard or
   commands. A bot's Administrator permission grants no access to the vendor's
   configuration service. Adding a vendor integration is separate work and
   needs its actual API documentation and authorisation.
7. Run `check_bot_setup` again with the same requirements. Then verify the
   vendor's feature in its own service or through a user-triggered action.

## What the result proves

`requirements_met: true` means the installed bot meets the supplied server
permissions, channel permissions and role assignment requirements in the
snapshot just read. It does not prove the bot is online, that privileged
gateway intents are enabled, or that vendor settings or command permissions
are correct. Another service can change the server immediately afterwards.

Administrator bypasses channel overwrites but never role hierarchy. The check
uses Discord's ID tie-breaker when roles share a position. Assignment also
requires Manage Roles and an ordinary role below the target bot. Editing a
role's permissions has a separate restriction: the bot can only grant
permissions it holds. Assignment is not subject to that restriction.

If steward cannot read a requested channel, that channel is `unverified` and
`requirements_met` stays false. The other bot may still have access; the check
does not guess. Give steward View Channel and try again. Only explicitly
requested channels are checked, so the result never claims a complete
inventory of channels invisible to steward.

Threads are reported as unverified: their membership and inherited permissions
need separate checks. Voice and stage checks account for Connect being required
for speaking, streaming, voice activity, priority speaking, requesting to speak
and managing the channel.

The tool requires `read` scope, respects both the server and credential guild
allowlists, and is available in `READ_ONLY` mode. It makes no Discord writes.
