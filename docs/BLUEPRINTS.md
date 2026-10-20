# Blueprints

A blueprint describes the parts of a Discord server steward manages: roles and
their order, categories and channels and their order, permission overwrites,
server settings, bot-owned messages, the welcome flow, self-assignable roles
and their panels, and AutoMod rules. You hand it to `plan_blueprint`, read the
plan, and `apply_plan` it.

It is YAML or JSON. `blueprint_reference` returns a short version of this page
to an agent; `export_blueprint` produces a blueprint from a live server.

---

## The workflow

```
validate_blueprint ─> plan_blueprint ─> (review) ─> apply_plan ─> verify_blueprint
```

1. **Validate** checks the document offline: schema, unique keys, references,
   permission names, Discord limits, and the role-safety rules. No Discord
   calls.
2. **Plan** reads the live server and computes the steps. Nothing changes on
   Discord. The plan is stored with an ID and expires after
   `PLAN_TTL_MINUTES` (30 by default).
3. **Review** the summary, the blocked steps (each with a reason), the
   unsupported items and the warnings. `get_plan` pages through long plans.
4. **Apply** re-reads the server, refuses if anything relevant changed since
   the plan (`stale_plan`), and executes the steps in order. Long applies return
   `running`; poll `get_apply_status`.
5. **Verify** re-reads the server and reports any remaining differences.

Running the same blueprint again produces an empty plan.

## Identity: keys, not names

Every role, category, channel, message, panel and AutoMod rule has a `key`:
1-64 characters of `a-z`, `0-9`, `-`, `_`, not all digits. The key is what
steward remembers; names can change freely and two resources can share a name.

The first time a key is applied, steward creates the resource and stores
`key → Discord ID`. Later plans update that resource — rename it, move it,
change its permissions — and never create a second one. To bind a key to
something that already exists, use one of:

- `export_blueprint` — assigns keys to everything in the server and records
  them (the usual starting point for an existing server);
- `id: "<snowflake>"` on the blueprint entry;
- `adopt_by_name: true` on `plan_blueprint`, which binds entries to existing,
  unbound resources with exactly the same name (and type);
- `map_resource`.

Without one of these, a plan that finds an unbound resource with the same name
creates a new one and warns you about the collision.

## What is managed

Only what you write down. A role without `permissions` keeps whatever it has;
a channel without `topic` keeps its topic. Resources that are not in the
blueprint are left alone.

Removing something from the blueprint does **not** delete it. Deletion is a
separate, explicit choice on the plan:

| `prune` option | Deletes |
| --- | --- |
| `roles` | Roles steward manages (bound to a key) that the blueprint no longer lists |
| `channels` | Channels and categories, likewise. Channels are deleted before categories. |
| `overwrites` | Overwrites on managed channels for roles/members the blueprint does not list |
| `messages` | Managed messages no longer listed |
| `panels` | Role panels no longer listed |
| `automod` | AutoMod rules no longer listed |

`prune_unmanaged: true` extends pruning to resources steward never managed —
everything in the server the blueprint does not mention. `@everyone`,
integration roles, the bot's roles and protected staff roles are never pruned
that way. Plans with deletions need `ALLOW_DESTRUCTIVE=true` on the server and a
credential with the `destructive` scope.

## Format

### Top level

```yaml
version: 1 # required
name: My server # optional label, shown in plans
description: ... # optional
settings: { ... } # server settings
everyone: { permissions: [...] }
roles: [...] # top to bottom
categories: [...] # in display order, each with its channels
channels: [...] # channels outside any category
messages: [...]
welcome: { ... }
self_roles: { roles: [...], panels: [...] }
automod: [...]
```

Unknown fields are errors, so typos do not silently do nothing.

### References

Wherever a role is expected you can write a role **key**, `everyone`, or a raw
Discord role ID (for roles the blueprint does not manage, such as another
bot's role). Wherever a channel is expected: a channel or category key, or a
raw channel ID.

### Permissions

Permission names are Discord's PascalCase names: `ViewChannel`,
`SendMessages`, `ManageMessages`, `KickMembers`, `Administrator`, …
`SCREAMING_SNAKE_CASE` works too. `blueprint_reference` lists them all.

A list of permissions on a role, or on `everyone`, is the **exact** set.

### Roles

```yaml
roles:
  - key: moderator
    name: Moderator
    color: '#3498db' # or an integer
    hoist: true # shown separately in the member list
    mentionable: true
    permissions: [KickMembers, ManageMessages]
    staff: true # never self-assignable or given on join
    id: '123456789012345678' # optional: bind to an existing role
```

The list order is the role order, top first, and is applied. Only roles steward
can move take part: roles at or above the bot's own highest role stay where
they are (the plan warns). Roles not in the blueprint keep their slots;
managed roles are reordered within the slots they occupy.

`staff: true` adds the role to the server's protected list. Protected roles,
and roles that carry moderation or admin power at server level or through any
channel overwrite, can never be self-assignable or join roles.

`everyone: { permissions: [...] }` sets `@everyone`'s server-wide permissions.

### Categories and channels

```yaml
categories:
  - key: staff
    name: Staff
    access: { private: true, visible_to: [moderator] }
    channels:
      - key: mod-chat
        name: mod-chat
      - key: mod-voice
        name: Mod Voice
        type: voice
        user_limit: 5

channels:
  - key: lobby
    name: lobby
    topic: Say hi.
    slowmode_seconds: 30
```

Channel fields:

| Field | Applies to | Notes |
| --- | --- | --- |
| `key`, `name` | all | Text-like channel names must already be in Discord's form: lower case, no spaces (`general-chat`). |
| `type` | all | `text` (default), `voice`, `announcement`, `stage`, `forum`, `media`. Announcement and stage need the Community feature. |
| `topic` | text, announcement, forum, media, stage | |
| `nsfw` | all | |
| `slowmode_seconds` | all text chats | 0-21600 |
| `bitrate`, `user_limit` | voice, stage | Bitrate is capped by the server's boost tier. |
| `permissions` | all | Explicit overwrites (below). |
| `access` | all | Presets (below). |
| `sync_permissions` | channels in a category | Default **true** when the channel has no `permissions`/`access`: it gets the category's overwrites. `false` leaves its overwrites unmanaged. |
| `id` | all | Bind to an existing channel. |

Discord cannot change a channel's type, except text ↔ announcement in a
Community server; the plan reports any other type change as unsupported.

Order inside a category is the list order, applied separately to text-like and
voice-like channels (Discord always lists text above voice). Categories are
ordered by the `categories` list. Unmanaged channels keep their slots.

### Permission overwrites

```yaml
permissions:
  - role: everyone
    deny: [ViewChannel]
  - role: moderator
    allow: [ViewChannel, ManageMessages]
  - member: '123456789012345678'
    allow: [ViewChannel]
```

Each entry sets that target's overwrite exactly. Targets you do not list are
left as they are (the plan warns, and warns loudly if they make a private
channel visible) unless the plan sets `prune.overwrites`.

### Access presets

```yaml
access:
  private: true # @everyone cannot see it
  visible_to: [moderator] # ...these roles can
  read_only: true # @everyone cannot post (or speak, in voice)
  writers: [moderator] # ...these roles can
```

Presets expand to overwrites and combine with `permissions` (explicit entries
win for the same target). If the bot does not have Administrator, steward adds
an overwrite so the bot can still see and manage a private channel.

### Settings

```yaml
settings:
  name: My Server
  description: ...
  verification_level: none | low | medium | high | very_high
  default_notifications: all_messages | only_mentions
  explicit_content_filter: disabled | members_without_roles | all_members
  afk_channel: <voice channel> # or null
  afk_timeout: 60 | 300 | 900 | 1800 | 3600
  system_channel: <text channel> # or null
  system_channel_flags:
    suppress_join_notifications: true
    suppress_premium_subscriptions: false
    suppress_guild_reminders: true
    suppress_join_notification_replies: false
  rules_channel: <text channel>
  public_updates_channel: <text channel>
  safety_alerts_channel: <text channel>
  preferred_locale: en-US
  premium_progress_bar: true
  community: true
```

Every field is optional. `community: true` needs `rules_channel`,
`public_updates_channel`, verification `low` or higher and
`explicit_content_filter: all_members`; steward creates the referenced channels
first, enables Community, then creates any announcement and stage channels.
Server icon, banner and other image settings are not managed.

### Messages

```yaml
messages:
  - key: rules-post
    channel: rules
    content: Optional plain text.
    embeds:
      - title: Rules
        description: |
          1. Be kind.
        color: '#e74c3c'
        fields: [{ name: Contact, value: Ask a Moderator, inline: false }]
        footer: { text: Thanks! }
```

steward posts the message once and edits it in place when the content changes.
If someone deletes it, the next plan posts it again. Changing `channel` posts it
in the new channel and deletes the old copy. Blueprint messages never ping
anyone.

### Welcome

```yaml
welcome:
  enabled: true
  channel: general
  message:
    content: 'Welcome {user} to **{server}**! You are member #{member_count}.'
  join_roles: [member]
```

Placeholders: `{user}` (a mention of the new member — the only ping allowed),
`{username}`, `{server}`, `{member_count}`. Names are escaped so they cannot
inject formatting or mentions. Join roles must not be privileged. Needs
`DISCORD_MEMBERS_INTENT=true`; the plan warns otherwise.

### Self-assignable roles and panels

```yaml
self_roles:
  roles: [he-him, she-her, gamer] # the allowlist
  panels:
    - key: pronouns
      channel: roles
      title: Pronouns
      description: Optional.
      mode: single # multiple (default) or single
      options:
        - { role: he-him, label: he/him, emoji: '🔵', style: secondary }
```

`roles` is the complete allowlist when `self_roles` is present. Every panel
option must be on it. A panel is one message with up to 25 buttons; pressing
a button toggles the role; `single` lets a member hold one of the panel's
roles at a time. Styles: `primary`, `secondary`, `success`, `danger`. Emoji:
a Unicode emoji or `<:name:id>`.

Privileged roles are refused at validation, at planning, at apply, and again on
every button press.

### AutoMod

```yaml
automod:
  - key: no-invites
    name: Block invite links
    enabled: true
    trigger:
      type: keyword # or spam | keyword_preset | mention_spam
      keywords: ['*badword*']
      regex_patterns: ['discord\.gg/\S+']
      allow_list: []
    actions:
      - { type: block_message, custom_message: Not here, please. }
      - { type: alert, channel: mod-log }
      - { type: timeout, duration_seconds: 600 } # keyword and mention_spam only
    exempt_roles: [moderator]
    exempt_channels: [staff-chat]
```

Triggers: `keyword` (`keywords`, `regex_patterns`, `allow_list`), `spam`,
`keyword_preset` (`presets`: `profanity`, `sexual_content`, `slurs`;
`allow_list`), `mention_spam` (`mention_total_limit`, `raid_protection`;
leave out `mention_total_limit` to keep the server's current limit, but a new
rule needs it). Discord allows six keyword rules and one of each other kind
per server, counting rules steward does not manage. A rule cannot change its
trigger type; the plan reports that as unsupported. Member-profile rules are
not supported.

Updates send only the fields that differ from the live rule. Actions a
blueprint cannot describe (newer Discord action types) are kept as they are,
and the plan warns about them. Some rules are kept by Discord itself: they are
listed, but Discord can answer 404 Not Found when a bot changes or deletes
them. steward then fails that step with what it found (still listed, readable
by id or not), never deletes or recreates the rule, and runs the steps that
do not depend on it. Change such a rule in Server Settings → Safety Setup →
AutoMod, or make the blueprint match it.

## Plans in detail

A plan returns:

- `summary` — counts of creates, updates, deletes, reorders, blocked and
  unsupported items, warnings, and unchanged resources;
- `steps` — one line each, in execution order, marked `[destructive]` or
  `[BLOCKED: reason]`; `detail: "full"` returns every field and change;
- `blocked` — steps that cannot run, with the fix (hierarchy, missing
  permission, a privileged role in a safe-role list, …);
- `unsupported` — things Discord does not allow (type changes, Community-only
  channels without Community, ambiguous adoptions);
- `warnings` — name collisions, unmanaged overwrites, mapped resources deleted
  by hand, missing intents;
- `next` — what to do now.

`apply_plan` options:

- `continue_on_error` — keep going after a failed step; steps that depend on it
  are skipped, not attempted.
- `accept_blocked` — apply a plan that has blocked steps; those steps are
  skipped and reported.

Results per step: `succeeded`, `recovered` (Discord did not confirm, but the
resource was found and adopted), `noop` (already in the desired state),
`failed`, `uncertain`, `skipped`, `blocked`, `not_started`. Each lists the
operation IDs, which appear in `list_history` and in Discord's audit log.

After a partial run, fix the cause and plan again from the same blueprint.
Finished work shows up as unchanged; only what is missing is planned.

## Recipes

**Private staff area**

```yaml
categories:
  - key: staff
    name: Staff
    access: { private: true, visible_to: [moderator, admin] }
    channels:
      - { key: staff-chat, name: staff-chat }
      - { key: mod-log, name: mod-log }
```

**Read-only announcements**

```yaml
channels:
  - key: announcements
    name: announcements
    access: { read_only: true, writers: [moderator] }
```

**Opt-in channel unlocked by a self role**

```yaml
roles:
  - { key: gamer, name: Gamer }
channels:
  - key: gaming
    name: gaming
    access: { private: true, visible_to: [gamer, moderator] }
self_roles:
  roles: [gamer]
  panels:
    - { key: interests, channel: roles, title: Interests, options: [{ role: gamer, label: Gaming }] }
```

**Give another bot's role access to a channel** (its role ID from `list_roles`)

```yaml
channels:
  - key: music
    name: music
    permissions:
      - { role: '234395307759108106', allow: [ViewChannel, SendMessages, Connect, Speak] }
```

## Complete example

A general-purpose community: public chat, read-only information channels with
a rules post, an events category with a stage, a private staff area, a voice
category with an AFK channel, a welcome flow with a join role, three
self-role panels, and AutoMod. It is
[`examples/community.yaml`](../examples/community.yaml), reproduced here.

<!-- community.yaml begins: kept identical to examples/community.yaml by test/docs.test.ts -->
```yaml
# A complete community server: public channels, read-only announcements,
# a private staff area, self-assigned roles, a welcome flow and AutoMod.
# Walkthrough: docs/BLUEPRINTS.md
version: 1
name: Community starter
description: A friendly general-purpose community with a private staff area.

settings:
  verification_level: medium
  default_notifications: only_mentions
  explicit_content_filter: all_members
  community: true
  rules_channel: rules
  public_updates_channel: mod-updates
  system_channel: mod-log
  system_channel_flags:
    suppress_join_notifications: true # steward posts its own welcome message
    suppress_guild_reminders: true
  afk_channel: afk
  afk_timeout: 900

everyone:
  permissions:
    - ViewChannel
    - SendMessages
    - SendMessagesInThreads
    - CreatePublicThreads
    - ReadMessageHistory
    - AddReactions
    - EmbedLinks
    - AttachFiles
    - UseExternalEmojis
    - UseApplicationCommands
    - ChangeNickname
    - Connect
    - Speak
    - Stream
    - UseVAD

# Top to bottom, as they appear in Server Settings -> Roles.
roles:
  - key: admin
    name: Admin
    color: '#e74c3c'
    hoist: true
    permissions: [Administrator]
    staff: true
  - key: moderator
    name: Moderator
    color: '#3498db'
    hoist: true
    mentionable: true
    permissions:
      [
        KickMembers,
        BanMembers,
        ModerateMembers,
        ManageMessages,
        ManageThreads,
        ManageNicknames,
        MuteMembers,
        MoveMembers,
        ViewAuditLog,
      ]
    staff: true
  - key: member
    name: Member
    color: '#2ecc71'
    permissions: []
  - key: announcements-ping
    name: Announcements
  - key: events-ping
    name: Events
  - key: he-him
    name: he/him
  - key: she-her
    name: she/her
  - key: they-them
    name: they/them
  - key: gamer
    name: Gamer
    color: '#9b59b6'
  - key: artist
    name: Artist
    color: '#f1c40f'

categories:
  - key: info
    name: Information
    access:
      read_only: true
      writers: [admin, moderator]
    channels:
      - key: welcome
        name: welcome
        topic: Start here.
      - key: rules
        name: rules
        topic: Read these before posting.
      - key: announcements
        name: announcements
        type: announcement
        topic: News from the team.
      - key: roles
        name: roles
        topic: Pick your pronouns, pings and interests.

  - key: community
    name: Community
    channels:
      - key: general
        name: general
        topic: Talk about anything.
      - key: introductions
        name: introductions
        topic: Say hello.
        slowmode_seconds: 60
      - key: media
        name: media
        topic: Screenshots, art and clips.
        slowmode_seconds: 10
      - key: gaming
        name: gaming
        # Only people with the Gamer role see this one.
        access:
          private: true
          visible_to: [gamer, moderator, admin]
      - key: lounge
        name: Lounge
        type: voice
      - key: game-night
        name: Game Night
        type: voice
        user_limit: 10

  - key: events
    name: Events
    channels:
      - key: event-info
        name: event-info
        access:
          read_only: true
          writers: [moderator, admin]
      - key: town-hall
        name: Town Hall
        type: stage

  - key: staff
    name: Staff
    access:
      private: true
      visible_to: [moderator, admin]
    channels:
      - key: staff-chat
        name: staff-chat
      - key: mod-log
        name: mod-log
        topic: AutoMod alerts and join notices.
      - key: mod-updates
        name: mod-updates
        topic: Discord's Community updates for moderators.
      - key: staff-voice
        name: Staff Voice
        type: voice

  - key: voice
    name: Voice
    channels:
      - key: afk
        name: AFK
        type: voice

messages:
  - key: rules-post
    channel: rules
    embeds:
      - title: Server rules
        color: '#e74c3c'
        description: |
          1. Be kind. No harassment, hate speech or personal attacks.
          2. Keep it safe for work outside channels marked otherwise.
          3. No spam, advertising or unsolicited DMs.
          4. Use the right channel; keep threads on topic.
          5. Follow Discord's Terms of Service and Community Guidelines.

          Moderators may remove content or members that break these rules.
        footer:
          text: Questions? Ask a Moderator.
  - key: start-here
    channel: welcome
    embeds:
      - title: Welcome!
        color: '#2ecc71'
        description: |
          Read the rules channel first, then pick up roles in the roles channel.
          Say hello in introductions once you're settled.

welcome:
  enabled: true
  channel: general
  message:
    content: 'Welcome {user} to **{server}**! You are member #{member_count}. Have a look at the rules and roles channels to get started.'
  join_roles: [member]

self_roles:
  # The allowlist. Nothing else can ever be self-assigned, and steward refuses
  # any role here that carries moderation or admin power.
  roles: [announcements-ping, events-ping, he-him, she-her, they-them, gamer, artist]
  panels:
    - key: pings
      channel: roles
      title: Notifications
      description: Choose what you want to be pinged for.
      options:
        - { role: announcements-ping, label: Announcements, emoji: '📣', style: primary }
        - { role: events-ping, label: Events, emoji: '🎉', style: primary }
    - key: pronouns
      channel: roles
      title: Pronouns
      mode: single
      options:
        - { role: he-him, label: he/him }
        - { role: she-her, label: she/her }
        - { role: they-them, label: they/them }
    - key: interests
      channel: roles
      title: Interests
      description: Unlocks the matching channels.
      options:
        - { role: gamer, label: Gaming, emoji: '🎮', style: success }
        - { role: artist, label: Art, emoji: '🎨', style: success }

automod:
  - key: block-invites
    name: Block invite links
    trigger:
      type: keyword
      regex_patterns: ['discord(?:\.gg|(?:app)?\.com/invite)/\S+']
    actions:
      - { type: block_message, custom_message: 'Invite links are not allowed here.' }
      - { type: alert, channel: mod-log }
    exempt_roles: [moderator, admin]
  - key: spam
    name: Block suspected spam
    trigger: { type: spam }
    actions:
      - { type: block_message }
      - { type: alert, channel: mod-log }
  - key: mention-spam
    name: Mention spam
    trigger: { type: mention_spam, mention_total_limit: 6, raid_protection: true }
    actions:
      - { type: block_message }
      - { type: timeout, duration_seconds: 600 }
      - { type: alert, channel: mod-log }
    exempt_roles: [moderator, admin]
  - key: slurs
    name: Block slurs
    trigger: { type: keyword_preset, presets: [slurs] }
    actions:
      - { type: block_message }
```
<!-- community.yaml ends -->

Applied to an empty server where the bot has Administrator, this plans 41
creates, 4 updates and 6 reorders; applying the same file again plans nothing.
