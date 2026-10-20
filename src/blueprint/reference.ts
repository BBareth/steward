/**
 * The short reference handed to agents by the blueprint_reference tool. The
 * long-form documentation, with a complete example, is docs/BLUEPRINTS.md.
 */
export const BLUEPRINT_REFERENCE = `
Blueprint format (YAML or JSON), version 1. Identity is the "key"; names can change freely.

version: 1
name: <optional label>
settings:            # optional; only listed fields are managed
  verification_level: none|low|medium|high|very_high
  default_notifications: all_messages|only_mentions
  explicit_content_filter: disabled|members_without_roles|all_members
  afk_channel / system_channel / rules_channel / public_updates_channel / safety_alerts_channel: <channel key or ID, or null>
  afk_timeout: 60|300|900|1800|3600
  system_channel_flags: { suppress_join_notifications, suppress_premium_subscriptions, suppress_guild_reminders, suppress_join_notification_replies }
  preferred_locale, premium_progress_bar, name, description
  community: true|false     # needs rules_channel, public_updates_channel (text channels), verification >= low, filter all_members, bot Administrator; announcement/stage/forum/media channels are created after it (announcement, stage, media need it)
everyone: { permissions: [ViewChannel, SendMessages, ...] }   # exact @everyone permissions
roles:               # listed top to bottom; that order is applied
  - key: moderator           # a-z 0-9 - _, unique among roles
    name: Moderator
    color: "#3498db"         # optional
    hoist, mentionable: bool # optional
    permissions: [KickMembers, ManageMessages]   # optional; if present it is the exact set
    staff: true              # never self-assignable or given on join
    id: "<snowflake>"        # optional: bind to an existing role
categories:          # listed in display order
  - key: staff
    name: Staff
    access: { private: true, visible_to: [moderator] }       # presets...
    permissions: [ { role: moderator, allow: [ManageMessages], deny: [] } ]   # ...or explicit overwrites
    channels:
      - key: mod-chat
        name: mod-chat                    # text-like names: lower case, no spaces
        type: text|voice|announcement|stage|forum|media   (default text)
        topic, nsfw, slowmode_seconds, bitrate, user_limit
        sync_permissions: true|false      # default: inherit the category's overwrites when the channel sets none
        access: { private, visible_to: [...], read_only, writers: [...] }
        permissions: [ { role: <key|everyone|ID> | member: <user ID>, allow: [...], deny: [...] } ]
channels: [ ...same as above, outside any category... ]
messages:            # bot-owned posts, edited in place when they change
  - { key: rules-post, channel: rules, content: "...", embeds: [ { title, description, color, fields: [{name, value, inline}], footer: {text} } ] }
welcome: { enabled: true, channel: general, message: { content: "Welcome {user} to {server}!" }, join_roles: [member] }
self_roles:
  roles: [gamer, artist]                 # the allowlist; privileged roles are refused
  panels:
    - { key: interests, channel: roles, title: Interests, mode: multiple|single,
        options: [ { role: gamer, label: Gaming, emoji: "🎮", style: primary|secondary|success|danger } ] }
automod:
  - key: no-invites
    name: Block invites
    trigger: { type: keyword, keywords: [...], regex_patterns: [...], allow_list: [...] }
             | { type: spam } | { type: keyword_preset, presets: [profanity, sexual_content, slurs] }
             | { type: mention_spam, mention_total_limit: 5, raid_protection: true }
    actions: [ { type: block_message, custom_message: "..." }, { type: alert, channel: mod-log }, { type: timeout, duration_seconds: 600 } ]
    exempt_roles: [moderator]
    exempt_channels: [staff-chat]

Rules:
- Re-applying the same blueprint changes nothing. Resources not in the blueprint are left alone unless a plan sets prune.
- Fields you omit are not managed. A role without "permissions" keeps whatever it has.
- Workflow: validate_blueprint -> plan_blueprint -> review -> apply_plan -> verify_blueprint.
- export_blueprint produces a starting point from a live server.
`.trim();
