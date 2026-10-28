import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * All persistent state, in one SQLite file. Writes are synchronous and
 * durable (WAL), which is what makes the operation journal useful: a row is
 * on disk before the Discord request it describes is sent.
 */

export type MappingKind = 'role' | 'channel' | 'automod';
export type MappingSource = 'created' | 'adopted' | 'exported' | 'pinned' | 'recovered' | 'manual';

export interface Mapping {
  guildId: string;
  kind: MappingKind;
  key: string;
  discordId: string;
  source: MappingSource;
  createdAt: string;
  updatedAt: string;
}

export type PlanStatus =
  'planned' | 'applying' | 'applied' | 'partial' | 'failed' | 'interrupted' | 'rejected';

export interface PlanRecord {
  id: string;
  guildId: string;
  blueprintName: string | null;
  blueprintHash: string;
  optionsJson: string;
  planJson: string;
  fingerprintsJson: string;
  status: PlanStatus;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  appliedAt: string | null;
  finishedAt: string | null;
  resultJson: string | null;
}

export type OperationStatus = 'in_progress' | 'succeeded' | 'failed' | 'uncertain' | 'recovered' | 'skipped';

export interface OperationRecord {
  id: string;
  guildId: string;
  planId: string | null;
  stepId: string | null;
  tool: string;
  clientId: string | null;
  action: string;
  resourceKind: string;
  resourceKey: string | null;
  targetId: string | null;
  /** Expected name/type/parent of a created resource, used to reconcile an uncertain create. */
  matchJson: string | null;
  summary: string;
  status: OperationStatus;
  attempts: number;
  auditReason: string | null;
  error: string | null;
  resultJson: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ToolCallRecord {
  id: string;
  clientId: string;
  tool: string;
  guildId: string | null;
  outcome: 'ok' | 'error' | 'denied';
  error: string | null;
  durationMs: number;
  createdAt: string;
}

export interface WelcomeConfig {
  guildId: string;
  enabled: boolean;
  channelId: string | null;
  message: { content?: string; embeds?: unknown[] } | null;
  joinRoleIds: string[];
  updatedAt: string;
}

export interface RolePanelOption {
  roleId: string;
  label: string;
  emoji?: string;
  style?: 'primary' | 'secondary' | 'success' | 'danger';
}

export interface RolePanel {
  id: string;
  guildId: string;
  key: string;
  channelId: string;
  messageId: string | null;
  title: string;
  description: string | null;
  mode: 'multiple' | 'single';
  options: RolePanelOption[];
  createdAt: string;
  updatedAt: string;
}

export interface ManagedMessage {
  guildId: string;
  key: string;
  channelId: string;
  messageId: string;
  payloadHash: string;
  updatedAt: string;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE resource_mappings (
    guild_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, kind, key)
  );
  CREATE UNIQUE INDEX resource_mappings_by_id ON resource_mappings (guild_id, kind, discord_id);

  CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    blueprint_name TEXT,
    blueprint_hash TEXT NOT NULL,
    options_json TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    fingerprints_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    applied_at TEXT,
    finished_at TEXT,
    result_json TEXT
  );
  CREATE INDEX plans_by_guild ON plans (guild_id, created_at);

  CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    plan_id TEXT,
    step_id TEXT,
    tool TEXT NOT NULL,
    client_id TEXT,
    action TEXT NOT NULL,
    resource_kind TEXT NOT NULL,
    resource_key TEXT,
    target_id TEXT,
    match_json TEXT,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    audit_reason TEXT,
    error TEXT,
    result_json TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX operations_by_guild ON operations (guild_id, started_at);
  CREATE INDEX operations_by_plan ON operations (plan_id);
  CREATE INDEX operations_by_status ON operations (status);

  CREATE TABLE tool_calls (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    guild_id TEXT,
    outcome TEXT NOT NULL,
    error TEXT,
    duration_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX tool_calls_by_time ON tool_calls (created_at);

  CREATE TABLE welcome_configs (
    guild_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    channel_id TEXT,
    message_json TEXT,
    join_role_ids_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE self_role_allowlist (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );

  CREATE TABLE protected_roles (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );

  CREATE TABLE role_panels (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    key TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (guild_id, key)
  );

  CREATE TABLE managed_messages (
    guild_id TEXT NOT NULL,
    key TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, key)
  );
  `,
  `
  CREATE TABLE dashboard_prompts (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reply TEXT,
    replied_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX dashboard_prompts_by_guild ON dashboard_prompts (guild_id, created_at);
  `,
];

const now = () => new Date().toISOString();

type Row = Record<string, unknown>;

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
        (r) => r.version,
      ),
    );
    MIGRATIONS.forEach((sql, i) => {
      const version = i + 1;
      if (applied.has(version)) return;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(version, now());
      })();
    });
  }

  schemaVersion(): number {
    return (this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
  }

  ping(): boolean {
    return (this.db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- mappings ---------------------------------------------------------------

  private static mapping(r: Row): Mapping {
    return {
      guildId: r.guild_id as string,
      kind: r.kind as MappingKind,
      key: r.key as string,
      discordId: r.discord_id as string,
      source: r.source as MappingSource,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  listMappings(guildId: string, kind?: MappingKind): Mapping[] {
    const rows = kind
      ? this.db
          .prepare('SELECT * FROM resource_mappings WHERE guild_id = ? AND kind = ? ORDER BY key')
          .all(guildId, kind)
      : this.db.prepare('SELECT * FROM resource_mappings WHERE guild_id = ? ORDER BY kind, key').all(guildId);
    return (rows as Row[]).map(Store.mapping);
  }

  getMapping(guildId: string, kind: MappingKind, key: string): Mapping | undefined {
    const r = this.db
      .prepare('SELECT * FROM resource_mappings WHERE guild_id = ? AND kind = ? AND key = ?')
      .get(guildId, kind, key) as Row | undefined;
    return r ? Store.mapping(r) : undefined;
  }

  findMappingById(guildId: string, kind: MappingKind, discordId: string): Mapping | undefined {
    const r = this.db
      .prepare('SELECT * FROM resource_mappings WHERE guild_id = ? AND kind = ? AND discord_id = ?')
      .get(guildId, kind, discordId) as Row | undefined;
    return r ? Store.mapping(r) : undefined;
  }

  /**
   * Bind `key` to `discordId`. Any other key that pointed at the same Discord
   * resource is released, so one resource never has two identities.
   */
  setMapping(
    guildId: string,
    kind: MappingKind,
    key: string,
    discordId: string,
    source: MappingSource,
  ): void {
    this.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM resource_mappings WHERE guild_id = ? AND kind = ? AND discord_id = ? AND key <> ?',
        )
        .run(guildId, kind, discordId, key);
      const t = now();
      this.db
        .prepare(
          `INSERT INTO resource_mappings (guild_id, kind, key, discord_id, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (guild_id, kind, key) DO UPDATE SET discord_id = excluded.discord_id, source = excluded.source, updated_at = excluded.updated_at`,
        )
        .run(guildId, kind, key, discordId, source, t, t);
    });
  }

  deleteMapping(guildId: string, kind: MappingKind, key: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM resource_mappings WHERE guild_id = ? AND kind = ? AND key = ?')
        .run(guildId, kind, key).changes > 0
    );
  }

  deleteMappingById(guildId: string, kind: MappingKind, discordId: string): void {
    this.db
      .prepare('DELETE FROM resource_mappings WHERE guild_id = ? AND kind = ? AND discord_id = ?')
      .run(guildId, kind, discordId);
  }

  // ---- plans ------------------------------------------------------------------

  private static plan(r: Row): PlanRecord {
    return {
      id: r.id as string,
      guildId: r.guild_id as string,
      blueprintName: (r.blueprint_name as string | null) ?? null,
      blueprintHash: r.blueprint_hash as string,
      optionsJson: r.options_json as string,
      planJson: r.plan_json as string,
      fingerprintsJson: r.fingerprints_json as string,
      status: r.status as PlanStatus,
      createdBy: (r.created_by as string | null) ?? null,
      createdAt: r.created_at as string,
      expiresAt: r.expires_at as string,
      appliedAt: (r.applied_at as string | null) ?? null,
      finishedAt: (r.finished_at as string | null) ?? null,
      resultJson: (r.result_json as string | null) ?? null,
    };
  }

  insertPlan(p: Omit<PlanRecord, 'appliedAt' | 'finishedAt' | 'resultJson'>): void {
    this.db
      .prepare(
        `INSERT INTO plans (id, guild_id, blueprint_name, blueprint_hash, options_json, plan_json, fingerprints_json, status, created_by, created_at, expires_at)
         VALUES (@id, @guildId, @blueprintName, @blueprintHash, @optionsJson, @planJson, @fingerprintsJson, @status, @createdBy, @createdAt, @expiresAt)`,
      )
      .run(p);
  }

  getPlan(id: string): PlanRecord | undefined {
    const r = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as Row | undefined;
    return r ? Store.plan(r) : undefined;
  }

  listPlans(guildId: string | null, limit: number, offset: number): PlanRecord[] {
    const rows = guildId
      ? this.db
          .prepare('SELECT * FROM plans WHERE guild_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
          .all(guildId, limit, offset)
      : this.db.prepare('SELECT * FROM plans ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
    return (rows as Row[]).map(Store.plan);
  }

  /** Atomically move a plan from one status to another. Returns false if it was not in `from`. */
  transitionPlan(
    id: string,
    from: PlanStatus[],
    to: PlanStatus,
    fields: { resultJson?: string } = {},
  ): boolean {
    const placeholders = from.map(() => '?').join(', ');
    const t = now();
    const res = this.db
      .prepare(
        `UPDATE plans SET status = ?,
           applied_at = CASE WHEN ? = 'applying' THEN ? ELSE applied_at END,
           finished_at = CASE WHEN ? IN ('applied', 'partial', 'failed', 'interrupted', 'rejected') THEN ? ELSE finished_at END,
           result_json = COALESCE(?, result_json)
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(to, to, t, to, t, fields.resultJson ?? null, id, ...from);
    return res.changes > 0;
  }

  setPlanResult(id: string, resultJson: string): void {
    this.db.prepare('UPDATE plans SET result_json = ? WHERE id = ?').run(resultJson, id);
  }

  // ---- operations journal -----------------------------------------------------

  private static operation(r: Row): OperationRecord {
    return {
      id: r.id as string,
      guildId: r.guild_id as string,
      planId: (r.plan_id as string | null) ?? null,
      stepId: (r.step_id as string | null) ?? null,
      tool: r.tool as string,
      clientId: (r.client_id as string | null) ?? null,
      action: r.action as string,
      resourceKind: r.resource_kind as string,
      resourceKey: (r.resource_key as string | null) ?? null,
      targetId: (r.target_id as string | null) ?? null,
      matchJson: (r.match_json as string | null) ?? null,
      summary: r.summary as string,
      status: r.status as OperationStatus,
      attempts: r.attempts as number,
      auditReason: (r.audit_reason as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      resultJson: (r.result_json as string | null) ?? null,
      startedAt: r.started_at as string,
      finishedAt: (r.finished_at as string | null) ?? null,
    };
  }

  startOperation(
    op: Pick<
      OperationRecord,
      | 'id'
      | 'guildId'
      | 'planId'
      | 'stepId'
      | 'tool'
      | 'clientId'
      | 'action'
      | 'resourceKind'
      | 'resourceKey'
      | 'targetId'
      | 'summary'
      | 'auditReason'
      | 'matchJson'
    >,
  ): void {
    this.db
      .prepare(
        `INSERT INTO operations (id, guild_id, plan_id, step_id, tool, client_id, action, resource_kind, resource_key, target_id, match_json, summary, status, attempts, audit_reason, started_at)
         VALUES (@id, @guildId, @planId, @stepId, @tool, @clientId, @action, @resourceKind, @resourceKey, @targetId, @matchJson, @summary, 'in_progress', 0, @auditReason, @startedAt)`,
      )
      .run({ ...op, startedAt: now() });
  }

  bumpAttempts(id: string): void {
    this.db.prepare('UPDATE operations SET attempts = attempts + 1 WHERE id = ?').run(id);
  }

  finishOperation(
    id: string,
    status: Exclude<OperationStatus, 'in_progress'>,
    fields: { targetId?: string | null; error?: string | null; resultJson?: string | null } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE operations SET status = ?, target_id = COALESCE(?, target_id), error = ?, result_json = COALESCE(?, result_json), finished_at = ?
         WHERE id = ?`,
      )
      .run(status, fields.targetId ?? null, fields.error ?? null, fields.resultJson ?? null, now(), id);
  }

  getOperation(id: string): OperationRecord | undefined {
    const r = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as Row | undefined;
    return r ? Store.operation(r) : undefined;
  }

  listOperations(filter: {
    guildId?: string;
    planId?: string;
    status?: OperationStatus;
    tool?: string;
    limit: number;
    offset: number;
  }): { items: OperationRecord[]; total: number } {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      where.push(clause);
      args.push(value);
    };
    if (filter.guildId) add('guild_id = ?', filter.guildId);
    if (filter.planId) add('plan_id = ?', filter.planId);
    if (filter.status) add('status = ?', filter.status);
    if (filter.tool) add('tool = ?', filter.tool);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM operations ${clause}`).get(...args) as { n: number }
    ).n;
    const order = filter.planId ? 'started_at ASC, rowid ASC' : 'started_at DESC, rowid DESC';
    const rows = this.db
      .prepare(`SELECT * FROM operations ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...args, filter.limit, filter.offset) as Row[];
    return { items: rows.map(Store.operation), total };
  }

  uncertainOperations(guildId: string): OperationRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM operations WHERE guild_id = ? AND status = 'uncertain' ORDER BY started_at")
        .all(guildId) as Row[]
    ).map(Store.operation);
  }

  /**
   * After a crash or hard stop, anything that was mid-flight is unknown: the
   * request may or may not have reached Discord. Mark it so the next plan can
   * reconcile it instead of trusting it either way.
   */
  markInterrupted(): { plans: number; operations: number } {
    return this.transaction(() => {
      const t = now();
      const operations = this.db
        .prepare(
          "UPDATE operations SET status = 'uncertain', error = 'interrupted before a response was recorded', finished_at = ? WHERE status = 'in_progress'",
        )
        .run(t).changes;
      const plans = this.db
        .prepare("UPDATE plans SET status = 'interrupted', finished_at = ? WHERE status = 'applying'")
        .run(t).changes;
      return { plans, operations };
    });
  }

  // ---- tool call history ------------------------------------------------------

  recordToolCall(rec: ToolCallRecord): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, client_id, tool, guild_id, outcome, error, duration_ms, created_at)
         VALUES (@id, @clientId, @tool, @guildId, @outcome, @error, @durationMs, @createdAt)`,
      )
      .run(rec);
  }

  listToolCalls(limit: number, offset: number, guildId?: string): { items: ToolCallRecord[]; total: number } {
    const clause = guildId ? 'WHERE guild_id = ?' : '';
    const args = guildId ? [guildId] : [];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM tool_calls ${clause}`).get(...args) as { n: number }
    ).n;
    const rows = this.db
      .prepare(`SELECT * FROM tool_calls ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as Row[];
    return {
      total,
      items: rows.map((r) => ({
        id: r.id as string,
        clientId: r.client_id as string,
        tool: r.tool as string,
        guildId: (r.guild_id as string | null) ?? null,
        outcome: r.outcome as ToolCallRecord['outcome'],
        error: (r.error as string | null) ?? null,
        durationMs: r.duration_ms as number,
        createdAt: r.created_at as string,
      })),
    };
  }

  // ---- welcome ----------------------------------------------------------------

  getWelcome(guildId: string): WelcomeConfig | undefined {
    const r = this.db.prepare('SELECT * FROM welcome_configs WHERE guild_id = ?').get(guildId) as
      Row | undefined;
    if (!r) return undefined;
    return {
      guildId,
      enabled: r.enabled === 1,
      channelId: (r.channel_id as string | null) ?? null,
      message: r.message_json ? JSON.parse(r.message_json as string) : null,
      joinRoleIds: JSON.parse(r.join_role_ids_json as string),
      updatedAt: r.updated_at as string,
    };
  }

  setWelcome(cfg: Omit<WelcomeConfig, 'updatedAt'>): void {
    this.db
      .prepare(
        `INSERT INTO welcome_configs (guild_id, enabled, channel_id, message_json, join_role_ids_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id) DO UPDATE SET enabled = excluded.enabled, channel_id = excluded.channel_id,
           message_json = excluded.message_json, join_role_ids_json = excluded.join_role_ids_json, updated_at = excluded.updated_at`,
      )
      .run(
        cfg.guildId,
        cfg.enabled ? 1 : 0,
        cfg.channelId,
        cfg.message ? JSON.stringify(cfg.message) : null,
        JSON.stringify(cfg.joinRoleIds),
        now(),
      );
  }

  // ---- self roles and protected roles -----------------------------------------

  listSelfRoles(guildId: string): string[] {
    return (
      this.db
        .prepare('SELECT role_id FROM self_role_allowlist WHERE guild_id = ? ORDER BY added_at')
        .all(guildId) as Array<{
        role_id: string;
      }>
    ).map((r) => r.role_id);
  }

  addSelfRole(guildId: string, roleId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO self_role_allowlist (guild_id, role_id, added_at) VALUES (?, ?, ?)')
      .run(guildId, roleId, now());
  }

  removeSelfRole(guildId: string, roleId: string): void {
    this.db
      .prepare('DELETE FROM self_role_allowlist WHERE guild_id = ? AND role_id = ?')
      .run(guildId, roleId);
  }

  listProtectedRoles(guildId: string): string[] {
    return (
      this.db
        .prepare('SELECT role_id FROM protected_roles WHERE guild_id = ? ORDER BY added_at')
        .all(guildId) as Array<{
        role_id: string;
      }>
    ).map((r) => r.role_id);
  }

  addProtectedRole(guildId: string, roleId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO protected_roles (guild_id, role_id, added_at) VALUES (?, ?, ?)')
      .run(guildId, roleId, now());
  }

  removeProtectedRole(guildId: string, roleId: string): void {
    this.db.prepare('DELETE FROM protected_roles WHERE guild_id = ? AND role_id = ?').run(guildId, roleId);
  }

  // ---- role panels ------------------------------------------------------------

  private static panel(r: Row): RolePanel {
    const cfg = JSON.parse(r.config_json as string) as Pick<
      RolePanel,
      'title' | 'description' | 'mode' | 'options'
    >;
    return {
      id: r.id as string,
      guildId: r.guild_id as string,
      key: r.key as string,
      channelId: r.channel_id as string,
      messageId: (r.message_id as string | null) ?? null,
      ...cfg,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  listPanels(guildId: string): RolePanel[] {
    return (
      this.db.prepare('SELECT * FROM role_panels WHERE guild_id = ? ORDER BY key').all(guildId) as Row[]
    ).map(Store.panel);
  }

  getPanel(id: string): RolePanel | undefined {
    const r = this.db.prepare('SELECT * FROM role_panels WHERE id = ?').get(id) as Row | undefined;
    return r ? Store.panel(r) : undefined;
  }

  getPanelByKey(guildId: string, key: string): RolePanel | undefined {
    const r = this.db
      .prepare('SELECT * FROM role_panels WHERE guild_id = ? AND key = ?')
      .get(guildId, key) as Row | undefined;
    return r ? Store.panel(r) : undefined;
  }

  upsertPanel(p: Omit<RolePanel, 'createdAt' | 'updatedAt'>): void {
    const t = now();
    const config = JSON.stringify({
      title: p.title,
      description: p.description,
      mode: p.mode,
      options: p.options,
    });
    this.db
      .prepare(
        `INSERT INTO role_panels (id, guild_id, key, channel_id, message_id, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id,
           config_json = excluded.config_json, updated_at = excluded.updated_at`,
      )
      .run(p.id, p.guildId, p.key, p.channelId, p.messageId, config, t, t);
  }

  deletePanel(id: string): void {
    this.db.prepare('DELETE FROM role_panels WHERE id = ?').run(id);
  }

  // ---- managed messages -------------------------------------------------------

  getManagedMessage(guildId: string, key: string): ManagedMessage | undefined {
    const r = this.db
      .prepare('SELECT * FROM managed_messages WHERE guild_id = ? AND key = ?')
      .get(guildId, key) as Row | undefined;
    return r
      ? {
          guildId,
          key,
          channelId: r.channel_id as string,
          messageId: r.message_id as string,
          payloadHash: r.payload_hash as string,
          updatedAt: r.updated_at as string,
        }
      : undefined;
  }

  listManagedMessages(guildId: string): ManagedMessage[] {
    return (
      this.db.prepare('SELECT * FROM managed_messages WHERE guild_id = ? ORDER BY key').all(guildId) as Row[]
    ).map((r) => ({
      guildId,
      key: r.key as string,
      channelId: r.channel_id as string,
      messageId: r.message_id as string,
      payloadHash: r.payload_hash as string,
      updatedAt: r.updated_at as string,
    }));
  }

  setManagedMessage(m: Omit<ManagedMessage, 'updatedAt'>): void {
    this.db
      .prepare(
        `INSERT INTO managed_messages (guild_id, key, channel_id, message_id, payload_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, key) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id,
           payload_hash = excluded.payload_hash, updated_at = excluded.updated_at`,
      )
      .run(m.guildId, m.key, m.channelId, m.messageId, m.payloadHash, now());
  }

  deleteManagedMessage(guildId: string, key: string): void {
    this.db.prepare('DELETE FROM managed_messages WHERE guild_id = ? AND key = ?').run(guildId, key);
  }
}
