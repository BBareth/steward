const $ = (selector) => document.querySelector(selector);
const state = {
  csrf: '',
  tools: [],
  guilds: [],
  guild: '',
  status: null,
  health: null,
  overview: null,
  view: 'overview',
  generation: 0,
  roles: [],
  channels: [],
};
const pages = {
  overview: ['Overview', 'A little order. A healthier community. Here’s how things are running.'],
  servers: ['Your servers', 'Every server Steward is in, and which of them it can manage.'],
  roles: ['Roles & permissions', 'Understand who can do what, and keep your role hierarchy in order.'],
  channels: ['Channels', 'A place for every conversation. Inspect access, settings, and structure.'],
  settings: ['Server setup', 'Your server’s settings, community features, and connected resources.'],
  operations: [
    'All operations',
    'The complete Steward toolkit, with guided inputs and a review before every write.',
  ],
  blueprints: ['Blueprints', 'Describe your server, review a dry-run plan, then apply it.'],
  inbox: ['AI request inbox', 'Write a request for a connected agent to pick up through MCP.'],
  activity: ['Activity', 'A record of operations, outcomes, and the clients behind them.'],
};
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, action, className = 'secondary') {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', () => Promise.resolve().then(action).catch(showError));
  return node;
}
function badge(text, kind = '') {
  return el('span', `badge ${kind}`, text);
}
function pretty(value) {
  return JSON.stringify(value, null, 2);
}
function rawText(value) {
  return value?.untrusted_text ?? value ?? '';
}
function output(value) {
  return el('pre', '', typeof value === 'string' ? value : pretty(value));
}
function notice(text, error = false) {
  const node = $('#notice');
  node.hidden = !text;
  node.className = `notice ${error ? 'error' : ''}`;
  node.textContent = text;
}
function showError(error) {
  notice(error.message ?? String(error), true);
}
function tool(name) {
  return state.tools.find((entry) => entry.name === name);
}
function currentGuild() {
  return state.guilds.find((guild) => guild.id === state.guild);
}
function scope(name) {
  return !!tool(name);
}
function panel(title, subtitle = '', actions) {
  const node = el('section', 'panel');
  const head = el('div', 'panel-head');
  const label = el('div');
  label.append(el('h2', '', title));
  if (subtitle) label.append(el('p', '', subtitle));
  head.append(label);
  if (actions) head.append(actions);
  const body = el('div', 'panel-body');
  node.append(head, body);
  return { node, body };
}
function stat(label, value, note, icon) {
  const node = el('div', 'stat');
  const title = el('div', 'stat-label', label);
  title.append(el('span', '', icon));
  node.append(title, el('div', 'stat-number', value), el('div', 'stat-note', note));
  return node;
}
function loading() {
  const node = el('div', 'loading');
  node.append(el('div', 'spinner'), el('span', '', 'Fetching live server data…'));
  return node;
}
async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (options.method && options.method !== 'GET') headers['x-steward-csrf'] = state.csrf;
  const res = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const data = await res.json();
  if (!res.ok || data.ok === false)
    throw new Error(data.data?.error?.message ?? data.error ?? `Request failed (${res.status})`);
  return data;
}
async function call(name, args = {}, confirmed = false) {
  const def = tool(name);
  if (!def) throw new Error('The server mode does not allow this operation.');
  const headers = { 'content-type': 'application/json' };
  if (confirmed) headers['x-steward-confirm'] = name;
  return (await api(`/api/tools/${name}`, { method: 'POST', headers, body: JSON.stringify(args) })).data;
}
async function allPages(name, args) {
  let cursor;
  const items = [];
  do {
    const page = await call(name, { ...args, limit: 200, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return items;
}
function selectedArgs(extra = {}) {
  return { guild_id: state.guild, ...extra };
}
function requireGuild() {
  if (!currentGuild()?.manageable || currentGuild().bot_present === false)
    throw new Error('Select a configured server that the bot has joined.');
}
function healthChrome() {
  const ready = state.health?.status === 'ready';
  $('#connection-dot').className = `dot ${ready ? 'ok' : 'bad'}`;
  $('#connection-label').textContent = ready ? 'All systems operational' : 'Service needs attention';
  $('#version').textContent = `Steward v${state.status?.version ?? '—'}`;
  $('#updated').textContent =
    `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
async function refreshData() {
  const [status, health, guilds] = await Promise.all([
    call('steward_status'),
    api('/api/health'),
    call('list_guilds'),
  ]);
  state.status = status;
  state.health = health;
  state.guilds = guilds.items;
  if (!state.guilds.some((g) => g.id === state.guild))
    state.guild = state.guilds.find((g) => g.manageable && g.bot_present)?.id ?? state.guilds[0]?.id ?? '';
  const selector = $('#guild');
  selector.replaceChildren();
  for (const guild of state.guilds) {
    const option = el(
      'option',
      '',
      `${guild.name}${!guild.configured ? ' · not configured' : guild.bot_present === false ? ' · bot absent' : ''}`,
    );
    option.value = guild.id;
    selector.append(option);
  }
  if (!state.guilds.length) {
    const option = el('option', '', 'No servers available');
    option.value = '';
    selector.append(option);
  }
  selector.value = state.guild;
  $('#server-count').textContent = String(state.guilds.length);
  healthChrome();
}
async function bootstrap() {
  const session = await api('/api/session');
  state.csrf = session.csrf;
  state.tools = (await api('/api/tools')).tools;
  $('#identity').textContent = `Local access · ${session.scopes.join(' / ')}`;
  await refreshData();
  await render();
}
function serverRow(guild) {
  const node = el('div', 'server-list-row');
  const avatar = guild.icon_url
    ? el('img', 'avatar')
    : el('div', 'avatar', guild.name.slice(0, 2).toUpperCase());
  if (guild.icon_url) {
    avatar.src = guild.icon_url;
    avatar.alt = '';
  }
  const text = el('div');
  text.append(el('h3', '', guild.name), el('div', 'small mono', guild.id));
  const actions = el('div', 'actions');
  actions.append(
    badge(
      guild.bot_present === null ? 'Connection unknown' : guild.bot_present ? 'Connected' : 'Bot absent',
      guild.bot_present ? '' : 'warn',
    ),
  );
  if (!guild.configured) actions.append(badge('Not configured', 'warn'));
  if (guild.manageable && guild.bot_present)
    actions.append(
      button(
        '↗',
        async () => {
          state.guild = guild.id;
          $('#guild').value = guild.id;
          location.hash = 'roles';
          await render();
        },
        'quiet',
      ),
    );
  node.append(avatar, text, actions);
  return node;
}
async function overviewView() {
  const root = el('div');
  const ready = state.health?.status === 'ready';
  const banner = el('div', 'status-banner');
  const text = el('div');
  text.append(
    el('h3', '', ready ? 'Everything is looking good.' : 'Your service needs a little attention.'),
    el(
      'p',
      '',
      ready
        ? 'Steward is connected to Discord and ready to look after your servers.'
        : (state.health?.discord?.detail ?? 'Check the connection and database status below.'),
    ),
  );
  banner.append(
    el('div', 'status-symbol', ready ? '✓' : '!'),
    text,
    badge(ready ? '●  Operational' : 'Attention needed', ready ? '' : 'warn'),
  );
  root.append(banner);
  const status = state.status;
  const stats = el('div', 'stats');
  stats.append(
    stat(
      'Connected servers',
      state.guilds.filter((g) => g.bot_present).length,
      `${state.guilds.filter((g) => g.configured).length} configured for management`,
      '▦',
    ),
    stat(
      'Discord gateway',
      status.discord.state === 'ready' ? 'Online' : status.discord.state,
      status.discord.bot?.tag ?? 'Waiting for bot identity',
      '◉',
    ),
    stat('Available operations', state.tools.length, 'Based on the server mode', '⌘'),
    stat('Service uptime', uptime(status.uptime_seconds), `Running version ${status.version}`, '◷'),
  );
  root.append(stats);
  const columns = el('div', 'grid-two');
  const left = el('div');
  const servers = panel(
    'Your servers',
    'Connected communities, all in one place.',
    button(
      'View all ↗',
      () => {
        location.hash = 'servers';
      },
      'quiet',
    ),
  );
  servers.body.className = '';
  for (const guild of state.guilds) servers.body.append(serverRow(guild));
  if (!state.guilds.length)
    servers.body.append(el('div', 'empty', 'The bot has not joined any visible servers.'));
  left.append(servers.node);
  const quick = panel('Make yourself at home', 'Your most useful tools are one click away.');
  const links = el('div', 'actions');
  for (const [label, view] of [
    ['Inspect roles', 'roles'],
    ['Browse channels', 'channels'],
    ['Open blueprints', 'blueprints'],
  ])
    links.append(
      button(label, () => {
        location.hash = view;
      }),
    );
  quick.body.append(links);
  left.append(quick.node);
  const right = el('div');
  const health = panel('System health', 'Live checks from this Steward instance.');
  for (const [label, value, ok] of [
    ['Discord connection', status.discord.state, ready],
    ['Database', state.health.database, state.health.database === 'ok'],
    ['MCP endpoint', '/mcp · available', true],
    ['Write access', status.modes.read_only ? 'Read-only mode' : 'Enabled', scope('create_role')],
    ['Destructive actions', scope('delete_role') ? 'Enabled' : 'Disabled', !scope('delete_role')],
  ]) {
    const row = el('div', 'health-row', label);
    row.append(badge(value, ok ? '' : 'warn'));
    health.body.append(row);
  }
  right.append(health.node);
  const help = el('div', 'help-card');
  help.append(
    el('h3', '', 'A plan before a change.'),
    el(
      'p',
      '',
      'Blueprints show exactly what will change before anything touches your server. Export what you have, edit it, and review the difference.',
    ),
  );
  const link = el('a', '', 'Explore blueprints ↗');
  link.href = '#blueprints';
  help.append(link);
  right.append(help);
  columns.append(left, right);
  root.append(columns);
  return root;
}
function uptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
function table(headers, rows) {
  const wrap = el('div', 'table-wrap');
  const node = el('table');
  const head = el('thead');
  const tr = el('tr');
  for (const label of headers) tr.append(el('th', '', label));
  head.append(tr);
  const body = el('tbody');
  for (const cells of rows) {
    const row = el('tr');
    for (const cell of cells) {
      const td = el('td');
      td.append(cell instanceof Node ? cell : document.createTextNode(String(cell ?? '—')));
      row.append(td);
    }
    body.append(row);
  }
  node.append(head, body);
  wrap.append(node);
  return wrap;
}
function searchableList(title, description, entries, headers, rowOf, create) {
  const section = panel(title, description);
  section.body.className = '';
  const toolbar = el('div', 'table-toolbar');
  const search = el('input', 'search');
  search.type = 'search';
  search.placeholder = `Search ${title.toLowerCase()}…`;
  search.setAttribute('aria-label', search.placeholder);
  toolbar.append(search);
  if (create) toolbar.append(create);
  const list = el('div');
  const draw = () => {
    const filtered = entries.filter((entry) =>
      `${entry.name} ${entry.id} ${entry.key ?? ''}`.toLowerCase().includes(search.value.toLowerCase()),
    );
    list.replaceChildren(
      filtered.length ? table(headers, filtered.map(rowOf)) : el('div', 'empty', 'No matching resources.'),
    );
  };
  search.addEventListener('input', draw);
  section.body.append(toolbar, list);
  draw();
  return section.node;
}
async function resourcesView(kind) {
  requireGuild();
  const roles = kind === 'roles';
  const entries = await allPages(roles ? 'list_roles' : 'list_channels', selectedArgs());
  state[kind] = entries;
  const createName = roles ? 'create_role' : 'create_channel';
  return searchableList(
    roles ? 'Roles' : 'Channels',
    `${entries.length} resources · live from Discord`,
    entries,
    roles
      ? ['Role', 'Hierarchy', 'Access', 'Blueprint key', '']
      : ['Channel', 'Type', 'Access', 'Blueprint key', ''],
    (entry) => {
      const name = el('div', 'role-name');
      name.append(
        el('span', '', roles ? '◇' : entry.kind === 'category' ? '▤' : '#'),
        el('span', '', entry.name),
      );
      const label = el('div');
      label.append(name, el('div', 'small mono', entry.id));
      return [
        label,
        roles ? `Position ${entry.position}` : entry.kind,
        badge(
          roles
            ? entry.managed
              ? 'Managed by app'
              : entry.manageable_by_bot
                ? 'Editable'
                : 'Out of reach'
            : entry.hidden_from_everyone
              ? 'Private'
              : 'Public',
          roles && !entry.manageable_by_bot ? 'warn' : '',
        ),
        entry.key ?? '—',
        button('Inspect →', () => inspectResource(roles ? 'role' : 'channel', entry), 'quiet'),
      ];
    },
    scope(createName)
      ? button(roles ? '+ Create role' : '+ Create channel', () => openTool(createName, selectedArgs()))
      : null,
  );
}
async function inspectResource(kind, entry) {
  const data = await call(`get_${kind}`, selectedArgs({ [`${kind}_id`]: entry.id }));
  const body = $('#editor-body');
  body.replaceChildren();
  $('#editor-title').textContent = entry.name;
  const actions = el('div', 'actions');
  const update = `update_${kind}`;
  if (scope(update) && (kind !== 'role' || data.bot_can?.edit === true))
    actions.append(
      button(`Edit ${kind}`, () =>
        openTool(
          update,
          selectedArgs({
            [`${kind}_id`]: entry.id,
            name: data.name,
            ...(kind === 'role'
              ? {
                  color: data.color,
                  permissions: data.permissions,
                  hoist: data.hoist ?? false,
                  mentionable: data.mentionable ?? false,
                }
              : {
                  topic: rawText(data.topic) || null,
                  slowmode_seconds: data.slowmode_seconds ?? 0,
                  nsfw: data.nsfw ?? false,
                }),
          }),
        ),
      ),
    );
  if (kind === 'channel' && scope('configure_channel_access'))
    actions.append(
      button('Edit access', () =>
        openTool('configure_channel_access', selectedArgs({ channel_id: entry.id })),
      ),
    );
  if (kind === 'role' && scope('assign_roles'))
    actions.append(
      button('Assign to member', () =>
        openTool('assign_roles', selectedArgs({ changes: [{ user_id: '', add: [entry.id], remove: [] }] })),
      ),
    );
  if (scope(`delete_${kind}`) && (kind !== 'role' || data.bot_can?.delete === true))
    actions.append(
      button(
        'Delete',
        () =>
          openTool(`delete_${kind}`, selectedArgs({ [`${kind}_id`]: entry.id, confirm_name: entry.name })),
        'quiet error',
      ),
    );
  body.append(actions, output(data));
  showEditor();
}
function showEditor() {
  if (!$('#editor-dialog').open) $('#editor-dialog').showModal();
}
async function settingsView() {
  requireGuild();
  const data = await call('get_guild_overview', selectedArgs());
  state.overview = data;
  const root = el('div');
  const base = panel(
    data.guild.name,
    'Server overview and bot capability checks.',
    scope('update_guild_settings')
      ? button('Edit server settings', () =>
          openTool(
            'update_guild_settings',
            selectedArgs({ name: data.guild.name, description: rawText(data.guild.description) || null }),
          ),
        )
      : null,
  );
  const details = el('dl', 'detail-grid');
  for (const [label, value] of [
    ['Server ID', data.guild.id],
    ['Owner', data.guild.owner_id],
    ['Members', data.guild.approximate_member_count ?? 'Not provided by Discord'],
    ['Verification', data.guild.verification_level],
    ['Locale', data.guild.preferred_locale],
    ['Community', data.guild.community ? 'Enabled' : 'Disabled'],
  ]) {
    const item = el('div');
    item.append(el('dt', '', label), el('dd', '', value));
    details.append(item);
  }
  base.body.append(details);
  if (data.bot.warnings?.length) {
    const warnings = el('ul', 'warning-list');
    for (const text of data.bot.warnings) warnings.append(el('li', '', text));
    base.body.append(warnings);
  }
  root.append(base.node);
  const inspect = panel(
    'Explore server resources',
    'Inspect everything Discord exposes to the bot. Each section reports its own access limitations.',
  );
  const tabs = el('div', 'tabs');
  const result = el('div');
  const sections = [
    ['Full setup', 'get_server_setup'],
    ['Expressions', 'list_expressions'],
    ['Events', 'list_scheduled_events'],
    ['Invites', 'list_invites'],
    ['Webhooks', 'list_webhooks'],
    ['Templates', 'list_templates'],
    ['Integrations', 'list_integrations'],
    ['AutoMod', 'list_automod_rules'],
    ['Bot features', 'get_bot_features'],
    ['Hierarchy', 'check_role_hierarchy'],
  ];
  for (const [label, name] of sections)
    if (scope(name))
      tabs.append(
        button(
          label,
          async () => {
            for (const b of tabs.children) b.classList.remove('active');
            const b = [...tabs.children].find((node) => node.textContent === label);
            b.classList.add('active');
            result.replaceChildren(loading());
            try {
              result.replaceChildren(output(await call(name, selectedArgs())));
            } catch (error) {
              result.replaceChildren(el('p', 'error', error.message));
            }
          },
          'secondary',
        ),
      );
  inspect.body.append(tabs, result);
  result.append(output(data));
  root.append(inspect.node);
  return root;
}
function sample(schema) {
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  const union = schema.anyOf ?? schema.oneOf;
  if (union) return sample(union.find((s) => s.type !== 'null') ?? union[0]);
  if (schema.type === 'object')
    return Object.fromEntries((schema.required ?? []).map((key) => [key, sample(schema.properties[key])]));
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return schema.minimum ?? 0;
  return '';
}
function schemaType(schema) {
  const union = schema.anyOf ?? schema.oneOf;
  if (union) {
    const types = union.filter((s) => s.type !== 'null');
    if (types.length === 1) return schemaType(types[0]);
    if (types.every((s) => s.const !== undefined)) return 'enum';
    if (
      types.some((s) => s.type === 'string') &&
      types.every((s) => ['string', 'number', 'integer'].includes(s.type))
    )
      return 'string';
    return 'json';
  }
  return Array.isArray(schema.type) ? schema.type.find((type) => type !== 'null') : schema.type;
}
function fieldLabel(name) {
  return name.replaceAll('_', ' ').replace(/^./, (v) => v.toUpperCase());
}
function toolForm(def, initial = {}) {
  const root = el('div');
  root.append(
    el('p', 'tool-description', def.description),
    el('div', 'scope-label', `${def.name} · ${def.scope} scope`),
  );
  const form = el('form');
  const fields = el('div', 'form-grid');
  const controls = new Map();
  for (const [name, schema] of Object.entries(def.inputSchema.properties ?? {})) {
    const required = (def.inputSchema.required ?? []).includes(name);
    const type = schemaType(schema);
    const wrap = el('div', `form-field ${['object', 'array', 'json'].includes(type) ? 'wide' : ''}`);
    const label = el('label', '', `${fieldLabel(name)}${required ? ' *' : ''}`);
    const controlId = `field-${def.name}-${name}`;
    label.htmlFor = controlId;
    let input;
    let format = type;
    const choices =
      schema.enum ?? (schema.anyOf ?? schema.oneOf)?.filter((s) => s.const !== undefined).map((s) => s.const);
    if (choices?.length || type === 'boolean') {
      input = el('select');
      const values = type === 'boolean' ? [true, false] : choices;
      const unset = el('option', '', required ? 'Choose a value…' : 'Leave unchanged / use default');
      unset.value = '';
      input.append(unset);
      for (const value of values) {
        const option = el('option', '', String(value));
        option.value = JSON.stringify(value);
        input.append(option);
      }
      format = 'choice';
    } else if (['object', 'array', 'json'].includes(type)) {
      input = el('textarea');
      input.rows = 4;
      input.className = 'mono';
      input.placeholder = pretty(sample(schema));
    } else {
      input = el('input');
      input.type = ['integer', 'number'].includes(type) ? 'number' : 'text';
      if (input.type === 'number') {
        input.step = type === 'integer' ? '1' : 'any';
        if (schema.minimum !== undefined) input.min = schema.minimum;
        if (schema.maximum !== undefined) input.max = schema.maximum;
      }
      if (schema.maxLength) input.maxLength = schema.maxLength;
    }
    input.id = controlId;
    input.name = name;
    input.required = required;
    input.autocomplete = 'off';
    const value =
      initial[name] !== undefined
        ? initial[name]
        : name === 'guild_id' && state.guild
          ? state.guild
          : schema.default;
    if (value !== undefined)
      input.value =
        format === 'choice' || ['object', 'array', 'json'].includes(type) || value === null
          ? JSON.stringify(value)
          : String(value);
    if (name === 'guild_id' && state.guild) {
      input.readOnly = true;
    }
    wrap.append(label, input);
    if (schema.description) wrap.append(el('p', 'small', schema.description));
    fields.append(wrap);
    controls.set(name, {
      input,
      type,
      format,
      required,
      nullable: (schema.anyOf ?? schema.oneOf ?? []).some((part) => part.type === 'null'),
    });
  }
  const advanced = el('details');
  const summary = el('summary', 'small muted', 'Advanced: edit request JSON');
  advanced.append(summary);
  const jsonEditor = el('textarea', 'code-editor');
  jsonEditor.rows = 10;
  jsonEditor.setAttribute('aria-label', 'Request JSON');
  advanced.append(jsonEditor);
  const collectFields = () => {
    const args = {};
    for (const [name, { input, type, format, required, nullable }] of controls) {
      const text = input.value;
      if (!text && !required) continue;
      if (nullable && text === 'null') args[name] = null;
      else if (format === 'choice' || ['object', 'array', 'json'].includes(type))
        args[name] = JSON.parse(text);
      else if (['integer', 'number'].includes(type)) args[name] = Number(text);
      else args[name] = text;
    }
    return args;
  };
  const collect = () => (advanced.open ? JSON.parse(jsonEditor.value) : collectFields());
  advanced.addEventListener('toggle', () => {
    if (advanced.open) {
      try {
        jsonEditor.value = pretty(collectFields());
      } catch {
        jsonEditor.value = pretty(initial);
      }
      for (const { input } of controls.values()) input.required = false;
    } else {
      try {
        const args = JSON.parse(jsonEditor.value);
        for (const [name, { input, type, format, required }] of controls) {
          const value = args[name];
          input.value =
            value === undefined
              ? ''
              : format === 'choice' || ['object', 'array', 'json'].includes(type) || value === null
                ? pretty(value)
                : String(value);
          input.required = required;
        }
      } catch {
        /* Keep form values when the JSON draft is invalid. */
      }
    }
  });
  const error = el('p', 'error');
  error.setAttribute('role', 'alert');
  const actions = el('div', 'actions');
  const submit = el(
    'button',
    def.scope === 'destructive' ? 'primary danger' : 'primary',
    def.scope === 'read' ? 'Run inspection' : 'Review operation →',
  );
  submit.type = 'submit';
  actions.append(submit);
  const result = el('div', 'output');
  form.append(fields, el('hr', 'subtle-divider'), advanced, error, actions, result);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      const args = collect();
      if (def.scope !== 'read') {
        const accepted = await review(def, args);
        if (!accepted) return;
      }
      const data = await call(def.name, args, def.scope !== 'read');
      result.replaceChildren(el('h3', '', 'Operation result'), output(data));
      if (def.scope !== 'read' && $('#editor-dialog').contains(root)) await render();
      if (def.scope !== 'read')
        notice(`${def.title} completed. Use Refresh to read back the current server state.`);
    } catch (e) {
      error.textContent = e.message;
    } finally {
      submit.disabled = false;
    }
  });
  root.append(form);
  return root;
}
function review(def, args) {
  return new Promise((resolve) => {
    const dialog = $('#review-dialog');
    $('#review-title').textContent =
      def.scope === 'destructive' ? 'Confirm destructive operation' : def.title;
    $('#review-description').textContent =
      def.name === 'submit_dashboard_prompt'
        ? 'This saves your request for a connected agent to fetch. It does not start an AI or change Discord.'
        : `Review the exact request below. ${def.scope === 'destructive' ? 'This action may permanently remove server resources.' : 'Changes are sent to Discord after you confirm.'}`;
    $('#review-args').textContent = pretty(args);
    $('#review-error').textContent = '';
    const confirm = $('#confirm-review');
    confirm.className = def.scope === 'destructive' ? 'primary danger' : 'primary';
    confirm.textContent = def.name === 'submit_dashboard_prompt' ? 'Queue request' : 'Confirm & apply';
    const cleanup = () => {
      confirm.onclick = null;
      $('#cancel-review').onclick = null;
      dialog.oncancel = null;
    };
    const finish = (value) => {
      cleanup();
      dialog.close();
      resolve(value);
    };
    confirm.onclick = () => finish(true);
    $('#cancel-review').onclick = () => finish(false);
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    dialog.showModal();
  });
}
function openTool(name, args = selectedArgs()) {
  const def = tool(name);
  if (!def) throw new Error('This operation is not available in the current server mode.');
  $('#editor-title').textContent = def.title;
  $('#editor-body').replaceChildren(toolForm(def, args));
  showEditor();
}
function operationsView() {
  const root = panel('Operation library', 'The same typed tools available to connected AI clients.');
  const layout = el('div', 'operation-layout');
  const nav = el('div', 'tool-nav');
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Find an operation…';
  search.setAttribute('aria-label', 'Find an operation');
  const list = el('div');
  nav.append(search, list);
  const editor = el('div');
  const draw = () => {
    list.replaceChildren();
    for (const def of state.tools.filter((t) =>
      `${t.title} ${t.name}`.toLowerCase().includes(search.value.toLowerCase()),
    )) {
      const b = button(
        def.title,
        () => {
          for (const node of list.children) node.classList.remove('active');
          b.classList.add('active');
          editor.replaceChildren(el('h2', '', def.title), toolForm(def, selectedArgs()));
        },
        'tool-item',
      );
      b.append(el('span', '', `${def.name} · ${def.scope}`));
      list.append(b);
    }
  };
  search.addEventListener('input', draw);
  draw();
  editor.append(
    el('h2', '', 'Choose an operation'),
    el(
      'p',
      'tool-description',
      'Browse the tools on the left. Inputs come directly from the tool schema, so the dashboard stays in step with MCP. Use the JSON editor for complex permission overwrites, events, and onboarding configurations.',
    ),
  );
  layout.append(nav, editor);
  root.body.append(layout);
  return root.node;
}
function blueprintsView() {
  requireGuild();
  const guild = state.guild;
  const root = panel('Server blueprint', 'Export → edit → validate → plan → review → apply → verify.');
  const editor = el('textarea', 'code-editor');
  editor.setAttribute('aria-label', 'Blueprint YAML or JSON');
  editor.value = 'version: 1\n';
  let plan = null;
  const results = el('div', 'output');
  const actions = el('div', 'actions');
  const apply = button('Apply reviewed plan', async () => {
    if (!plan) return;
    const args = { guild_id: guild, plan_id: plan.plan_id };
    if (!(await review(tool('apply_plan'), args))) return;
    for (const b of actions.querySelectorAll('button')) b.disabled = true;
    editor.disabled = true;
    try {
      let data = await call('apply_plan', args, true);
      results.replaceChildren(output(data));
      while (data.status === 'running' && editor.isConnected) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        data = await call('get_apply_status', { plan_id: args.plan_id });
        results.replaceChildren(output(data));
      }
      plan = null;
      notice('Apply finished. Use Verify to compare the result with your blueprint.');
    } finally {
      editor.disabled = false;
      for (const b of actions.querySelectorAll('button')) b.disabled = false;
      apply.disabled = true;
    }
  });
  apply.disabled = true;
  editor.addEventListener('input', () => {
    plan = null;
    apply.disabled = true;
  });
  const perform = (label, fn) =>
    button(label, async () => {
      for (const b of actions.querySelectorAll('button')) b.disabled = true;
      try {
        await fn();
      } finally {
        for (const b of actions.querySelectorAll('button')) b.disabled = false;
        apply.disabled =
          !plan ||
          !scope('apply_plan') ||
          plan.blocked?.length > 0 ||
          !Object.values(plan.summary ?? {}).some((n) => n > 0);
      }
    });
  actions.append(
    perform('Export current server', async () => {
      const data = await call('export_blueprint', {
        guild_id: guild,
        record_mappings: false,
        include_ids: true,
      });
      editor.value = data.blueprint;
      plan = null;
      results.replaceChildren(
        output({
          notes: data.notes,
          message: 'Exported without changing mappings. Edit this blueprint, then plan it.',
        }),
      );
    }),
    perform('Validate', async () =>
      results.replaceChildren(output(await call('validate_blueprint', { blueprint: editor.value }))),
    ),
    perform('Create dry-run plan', async () => {
      const next = await call('plan_blueprint', { guild_id: guild, blueprint: editor.value });
      plan = next;
      results.replaceChildren(output(next));
    }),
    apply,
    perform('Verify', async () =>
      results.replaceChildren(
        output(await call('verify_blueprint', { guild_id: guild, blueprint: editor.value })),
      ),
    ),
  );
  root.body.append(
    editor,
    el(
      'p',
      'small muted',
      'Changing the blueprint invalidates this view’s plan. Steward also rejects expired plans and plans made against stale server state. Pruning is available through All operations.',
    ),
    actions,
    results,
  );
  return root.node;
}
async function inboxView() {
  requireGuild();
  const guild = state.guild;
  const root = el('div');
  const compose = panel('A request for your AI', 'Requests persist here until an agent picks them up.');
  const text = el('textarea');
  text.placeholder = 'For example: review our role hierarchy and propose a cleaner setup…';
  text.maxLength = 8000;
  text.setAttribute('aria-label', 'Request for a connected AI agent');
  const help = el(
    'p',
    'small muted',
    'MCP lets an AI call Steward’s tools. It does not send messages to an existing Codex chat or run a model. Ask your connected agent to read list_dashboard_prompts and reply with reply_dashboard_prompt. Automatic execution requires a separately configured agent runtime.',
  );
  const copy = button('Copy agent handoff', async () => {
    const message = `Read Steward’s list_dashboard_prompts for guild ${guild}. Review pending requests against my authorization, inspect the server before changes, and record verified results with reply_dashboard_prompt. Request: ${text.value.trim() || '(see inbox)'}`;
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(message);
      notice('Agent handoff copied. Paste it into your connected AI chat.');
    } else {
      const box = el('textarea');
      box.value = message;
      box.setAttribute('aria-label', 'Agent handoff to copy');
      compose.body.append(box);
      box.select();
      notice('Copy the selected handoff and paste it into your connected AI chat.');
    }
  });
  const actions = el('div', 'actions');
  if (scope('submit_dashboard_prompt'))
    actions.append(
      button(
        'Queue request',
        async () => {
          const args = { guild_id: guild, prompt: text.value.trim() };
          if (!args.prompt) throw new Error('Write a request first.');
          if (!(await review(tool('submit_dashboard_prompt'), args))) return;
          await call('submit_dashboard_prompt', args, true);
          notice('Request queued. Ask your connected agent to fetch the inbox.');
          await render();
        },
        'primary',
      ),
    );
  actions.append(copy);
  compose.body.append(text, help, actions);
  root.append(compose.node);
  const inbox = panel('Recent requests', 'Pending requests and replies from connected agents.');
  inbox.body.className = '';
  const data = await call('list_dashboard_prompts', { guild_id: guild, status: 'all', limit: 100 });
  if (!data.items.length)
    inbox.body.append(el('div', 'empty', 'A quiet inbox. Your first request will appear here.'));
  for (const item of data.items) {
    const card = el('article', 'prompt-card');
    const meta = el('div', 'request-meta');
    meta.append(
      badge(item.status, item.status === 'pending' ? 'warn' : ''),
      el('span', '', `${item.client_id} · ${new Date(item.created_at).toLocaleString()}`),
    );
    card.append(meta, el('p', '', rawText(item.prompt)));
    if (item.reply)
      card.append(
        el('p', 'reply', rawText(item.reply)),
        el('div', 'small muted', `Reply from ${item.replied_by}`),
      );
    card.append(el('div', 'small mono muted', item.id));
    inbox.body.append(card);
  }
  root.append(inbox.node);
  return root;
}
async function activityView() {
  requireGuild();
  const data = await call('list_history', selectedArgs({ limit: 100 }));
  const root = panel(
    'Operation history',
    'Most recent journal entries. Tool call history is also available below.',
  );
  root.body.className = '';
  if (!data.items?.length)
    root.body.append(el('div', 'empty', 'No Discord operations recorded for this server yet.'));
  else
    root.body.append(
      table(
        ['Operation', 'Action', 'Status', 'Started'],
        data.items.map((item) => [
          item.summary ?? item.id,
          item.action ?? item.tool,
          badge(item.status, ['succeeded', 'noop', 'recovered'].includes(item.status) ? '' : 'warn'),
          item.started_at ?? item.created_at,
        ]),
      ),
    );
  const details = el('div', 'panel-body');
  details.append(
    button('Inspect tool call history', () => openTool('list_history', selectedArgs({ kind: 'tool_calls' }))),
    output(data),
  );
  root.body.append(details);
  return root.node;
}
async function render() {
  const generation = ++state.generation;
  const view = location.hash.slice(1) || 'overview';
  state.view = pages[view] ? view : 'overview';
  const [title, description] = pages[state.view];
  $('#page-title').textContent = title;
  $('#breadcrumb').textContent = title;
  $('#page-description').textContent = description;
  for (const link of $('#nav').querySelectorAll('a')) {
    link.classList.toggle('active', link.dataset.view === state.view);
    if (link.dataset.view === state.view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $('#content').replaceChildren(loading());
  try {
    let content;
    if (state.view === 'overview') content = await overviewView();
    else if (state.view === 'servers') {
      const servers = panel(
        'Bot membership',
        'Servers outside DISCORD_GUILD_IDS are listed, but cannot be managed.',
      );
      servers.body.className = '';
      for (const guild of state.guilds) servers.body.append(serverRow(guild));
      content = servers.node;
    } else if (state.view === 'roles' || state.view === 'channels') content = await resourcesView(state.view);
    else if (state.view === 'settings') content = await settingsView();
    else if (state.view === 'operations') content = operationsView();
    else if (state.view === 'blueprints') content = blueprintsView();
    else if (state.view === 'inbox') content = await inboxView();
    else content = await activityView();
    if (generation === state.generation) $('#content').replaceChildren(content);
  } catch (error) {
    if (generation === state.generation)
      $('#content').replaceChildren(el('div', 'notice error', error.message));
  }
}
$('#guild').addEventListener('change', async () => {
  state.guild = $('#guild').value;
  state.overview = null;
  notice('');
  $('#editor-dialog').close();
  await render();
});
$('#refresh').addEventListener('click', async () => {
  $('#refresh').disabled = true;
  try {
    await refreshData();
    await render();
    notice('Live server data refreshed.');
  } catch (error) {
    showError(error);
  } finally {
    $('#refresh').disabled = false;
  }
});
$('#close-editor').addEventListener('click', () => $('#editor-dialog').close());
window.addEventListener('hashchange', () => {
  notice('');
  void render();
});
setInterval(async () => {
  if (!state.csrf || document.hidden) return;
  try {
    const [status, health] = await Promise.all([call('steward_status'), api('/api/health')]);
    state.status = status;
    state.health = health;
    healthChrome();
    if (state.view === 'overview') {
      const content = await overviewView();
      if (state.view === 'overview') $('#content').replaceChildren(content);
    }
  } catch (error) {
    showError(error);
  }
}, 30000);
$('#content').replaceChildren(loading());
try {
  await bootstrap();
} catch (error) {
  $('#connection-dot').className = 'dot bad';
  $('#connection-label').textContent = 'Steward is unreachable';
  $('#content').replaceChildren(el('div', 'notice error', `Could not load the dashboard: ${error.message}`));
}
