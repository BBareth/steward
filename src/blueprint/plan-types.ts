import type { MessageContent } from '../features/messages.js';
import type { MappingKind } from '../store.js';
import type { RefString } from './refs.js';

export interface PruneOptions {
  roles: boolean;
  channels: boolean;
  overwrites: boolean;
  messages: boolean;
  automod: boolean;
  panels: boolean;
}

export interface PlanOptions {
  /** Delete resources steward manages that the blueprint no longer lists. Off by default. */
  prune: PruneOptions;
  /** Extend pruning to resources steward never managed. Dangerous; off by default. */
  prune_unmanaged: boolean;
  /** Bind blueprint entries to existing, unmapped resources with the same name. Off by default. */
  adopt_by_name: boolean;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  prune: { roles: false, channels: false, overwrites: false, messages: false, automod: false, panels: false },
  prune_unmanaged: false,
  adopt_by_name: false,
};

export interface Change {
  field: string;
  from: unknown;
  to: unknown;
}

export interface OverwriteRef {
  /** A role RefString or "member:<id>". */
  target: RefString;
  type: 'role' | 'member';
  allow: string;
  deny: string;
}

export interface ChannelFields {
  name?: string;
  type?: number;
  topic?: string | null;
  nsfw?: boolean;
  rate_limit_per_user?: number;
  bitrate?: number;
  user_limit?: number;
}

export interface RoleFields {
  name?: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  permissions?: string;
}

export interface SettingsFields {
  name?: string;
  description?: string | null;
  verification_level?: number;
  default_message_notifications?: number;
  explicit_content_filter?: number;
  afk_channel?: RefString | null;
  afk_timeout?: number;
  system_channel?: RefString | null;
  system_channel_flags?: number;
  rules_channel?: RefString | null;
  public_updates_channel?: RefString | null;
  safety_alerts_channel?: RefString | null;
  preferred_locale?: string;
  premium_progress_bar_enabled?: boolean;
  community?: boolean;
}

export interface AutoModFields {
  name: string;
  enabled: boolean;
  trigger_type: number;
  trigger_metadata: Record<string, unknown>;
  actions: Array<{ type: number; channel?: RefString; duration_seconds?: number; custom_message?: string }>;
  exempt_roles: RefString[];
  exempt_channels: RefString[];
}

export interface PanelFields {
  channel: RefString;
  title: string;
  description: string | null;
  mode: 'multiple' | 'single';
  options: Array<{
    role: RefString;
    label: string;
    emoji?: string;
    style?: 'primary' | 'secondary' | 'success' | 'danger';
  }>;
}

interface Base {
  id: string;
  summary: string;
  destructive: boolean;
  dependsOn: string[];
  /** Set when the step cannot run; it is skipped unless the problem is fixed and the plan regenerated. */
  blocked?: string;
}

export type PlanStep = Base &
  (
    | { action: 'adopt'; kind: MappingKind; key: string; discordId: string }
    | { action: 'create_role'; key: string; fields: RoleFields }
    | { action: 'update_role'; key: string; roleId: string; fields: RoleFields; changes: Change[] }
    | { action: 'reorder_roles'; order: string[] }
    | {
        action: 'create_channel';
        key: string;
        fields: ChannelFields;
        parent: RefString | null;
        overwrites: OverwriteRef[];
      }
    | {
        action: 'update_channel';
        key: string;
        channelId: string;
        fields: ChannelFields;
        parent?: RefString | null;
        changes: Change[];
      }
    | {
        action: 'set_overwrites';
        key: string;
        channelId: string;
        put: OverwriteRef[];
        remove: string[];
        changes: Change[];
      }
    | {
        action: 'reorder_channels';
        parent: RefString | null;
        group: 'category' | 'text' | 'voice';
        order: string[];
      }
    | { action: 'update_settings'; fields: SettingsFields; changes: Change[] }
    | { action: 'create_automod'; key: string; fields: AutoModFields }
    | { action: 'update_automod'; key: string; ruleId: string; fields: AutoModFields; changes: Change[] }
    | {
        action: 'post_message';
        key: string;
        channel: RefString;
        content: MessageContent;
        payloadHash: string;
        replaces?: { channelId: string; messageId: string };
      }
    | {
        action: 'edit_message';
        key: string;
        channelId: string;
        messageId: string;
        content: MessageContent;
        payloadHash: string;
      }
    | {
        action: 'configure_welcome';
        enabled: boolean;
        channel: RefString | null;
        message: MessageContent | null;
        joinRoles: RefString[];
      }
    | {
        action: 'set_self_roles';
        /** null keeps the current allowlist. */ roles: RefString[] | null;
        protect: RefString[];
      }
    | {
        action: 'post_panel';
        key: string;
        panelId: string | null;
        fields: PanelFields;
        replaces?: { channelId: string; messageId: string };
      }
    | {
        action: 'edit_panel';
        key: string;
        panelId: string;
        channelId: string;
        messageId: string;
        fields: PanelFields;
      }
    | { action: 'delete_channel'; key: string | null; targetId: string; name: string }
    | { action: 'delete_role'; key: string | null; targetId: string; name: string }
    | { action: 'delete_automod'; key: string | null; targetId: string; name: string }
    | { action: 'delete_message'; key: string; channelId: string; messageId: string }
    | { action: 'delete_panel'; key: string; panelId: string; channelId: string; messageId: string | null }
  );

export type StepAction = PlanStep['action'];

export interface PlanIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PlanSummary {
  create: number;
  update: number;
  delete: number;
  reorder: number;
  other: number;
  unchanged: number;
  blocked: number;
  unsupported: number;
  warnings: number;
}

export interface PlanBody {
  guildId: string;
  guildName: string;
  blueprintName: string | null;
  blueprintHash: string;
  options: PlanOptions;
  summary: PlanSummary;
  steps: PlanStep[];
  unsupported: PlanIssue[];
  warnings: PlanIssue[];
  /** Whether the plan read AutoMod rules; apply must read the same state to compare fingerprints. */
  readsAutomod: boolean;
  /** Key → Discord ID as resolved when the plan was made; "(new)" for resources it creates. */
  resolution: Record<string, string>;
}
