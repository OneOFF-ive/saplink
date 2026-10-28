const $ = selector => document.querySelector(selector);
const icons = () => window.lucide?.createIcons();
const sessionKey = 'saplink-admin-session';
const freshKey = location.hash.slice(1);
if (freshKey) { sessionStorage.setItem(sessionKey, freshKey); history.replaceState(null, '', '/'); }
const adminKey = sessionStorage.getItem(sessionKey);
let state = { connections: [], tokens: [], running: false, mcp_port: 8765 };
let editing;
let working = false;
const tests = new Map();
const labels = { connections: '系统连接', tokens: '访问令牌', service: 'MCP 服务', updates: '软件更新' };
let toastTimer;
function toast(message, error = false) { const node = $('#toast'); node.textContent = message; node.className = error ? 'error' : '';
  node.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, 5000); }
async function api(path, method = 'GET', data) {
  const response = await fetch(`/api/${path}`, { method, headers: { 'X-Admin-Token': adminKey ?? '',
    ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
  if (response.status === 401) { $('#locked').hidden = false; throw new Error('管理会话已失效，请重新启动管理窗口'); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error?.message ?? `请求失败 (${response.status})`);
    error.fields = result.error?.fields ?? [];
    throw error;
  }
  return result;
}
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
  if (className) node.className = className; return node; }
function icon(name) { const node = element('i'); node.dataset.lucide = name; return node; }
function buttonIcon(name, title, action, disabled = false, danger = false) {
  const button = element('button', undefined, `icon-button${danger ? ' danger' : ''}`); button.title = title;
  button.setAttribute('aria-label', title); button.append(icon(name)); button.disabled = disabled;
  button.onclick = action; return button;
}
function badge(text, kind) { return element('span', text, `badge ${kind}`); }
let updateChecking = false;
let updateCheckError = '';
let updateRequested = false;
let updatePoll;
function renderUpdate() {
  const update = state.update;
  const install = state.update_install;
  const running = ['downloading', 'verifying', 'preparing', 'installing'].includes(install?.phase);
  $('#update-new').hidden = !update?.update_available;
  const check = $('#check-updates');
  check.hidden = Boolean(update?.update_available) && !updateCheckError;
  check.disabled = updateChecking || running;
  check.textContent = updateChecking ? '正在检查…' : '检查版本更新';
  const installButton = $('#install-update');
  const hasPackage = update?.source === 'cos' || update?.downloads?.some(item => item.architecture === install?.architecture);
  installButton.hidden = !update?.update_available;
  installButton.disabled = updateChecking || running || !install?.supported || !hasPackage || Boolean(updateCheckError);
  $('#update-summary').textContent = updateCheckError || (updateChecking ? '正在检查最新正式版本…' : running || install?.phase === 'failed' ? install.message :
    update?.update_available ? '发现新版本 ' + update.latest_version + '，当前版本 ' + state.version :
    update?.latest_version ? '当前版本 ' + state.version + '，更新源暂未提供更高的正式版本。' :
    update ? '暂未获取到可用的正式版本信息，请稍后重试。' : '可手动检查新版本。');
  const progress = $('#update-progress');
  progress.hidden = !running;
  if (install?.total_bytes) progress.value = Math.min(100, install.downloaded_bytes / install.total_bytes * 100);
  else progress.removeAttribute('value');
  if (running && install?.downloaded_bytes) $('#update-summary').textContent += '（已下载 ' + (install.downloaded_bytes / 1048576).toFixed(1) + ' MiB）';
  const notice = $('#update-notice');
  notice.hidden = !update?.update_available;
  notice.replaceChildren();
  if (update?.update_available) {
    const link = element('a', '查看发布说明与手动下载');
    link.href = update.release_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; notice.append(link);
    for (const download of update.downloads ?? []) {
      const link = element('a', 'Windows ' + download.architecture + (update.source === 'cos' ? ' 国内下载' : ' GitHub 下载'));
      link.href = download.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      notice.append(document.createTextNode(' · '), link);
    }
  }
  $('#release-details').hidden = !update?.update_available;
  $('#release-title').textContent = update?.release_title || '版本 ' + (update?.latest_version ?? '') + ' 更新内容';
  $('#release-notes').textContent = update?.release_notes || '暂未获取到该版本的更新说明。';
  const help = $('#update-help');
  const last = install?.last_result;
  help.textContent = update?.update_available && !install?.supported ? install?.unavailable_reason ?? '当前环境不支持自动安装。' :
    update?.update_available && !hasPackage ? '更新源尚无当前安装架构的有效安装包，请稍后重试或手动下载。' :
    last?.status === 'installed' ? '上次自动更新已安装版本 ' + last.version + '。' :
    last?.status === 'failed' || last?.status === 'unknown' ? '上次更新未确认完成，请检查配置目录中的 update-install-result.json。' : '';
  if (last?.installer_cleanup?.status === 'failed') help.textContent += ' 安装包自动清理失败，请在安装程序退出后手动删除：' + last.installer_cleanup.path;
  help.hidden = !help.textContent;
}
async function pollUpdate() {
  if (!updateRequested) return;
  try {
    const result = await api('updates/status');
    state.update = result.update; state.update_install = result.update_install; renderUpdate();
    if (state.update_install.phase === 'failed') { updateRequested = false; clearInterval(updatePoll); }
  } catch {
    clearInterval(updatePoll);
    $('#update-summary').textContent = '连接已断开，应用可能正在退出并安装更新。完成后将重新打开管理界面；请勿重复安装。';
  }
}
$('#check-updates').onclick = async () => {
  updateChecking = true; updateCheckError = ''; renderUpdate();
  try {
    const result = await api('updates/check', 'POST', {});
    state.update = result.update; state.update_install = result.update_install;
  } catch (error) { updateCheckError = error.message; toast(error.message, true); }
  finally { updateChecking = false; renderUpdate(); }
};
$('#install-update').onclick = () => {
  const version = state.update?.latest_version;
  if (!version) return;
  confirmAction('立即自动更新', '将下载并校验版本 ' + version + '，正常关闭当前应用后自动安装。MCP 连接将暂时中断，完成后尝试恢复原端口和运行状态。是否立即更新？', async () => {
    try {
      const result = await api('updates/install', 'POST', { version });
      state.update_install = result.update_install; updateRequested = true; renderUpdate();
      clearInterval(updatePoll); updatePoll = setInterval(pollUpdate, 1000); void pollUpdate();
    } catch (error) { toast(error.message, true); }
  });
};
function render() {
  $('#app-version').textContent = state.version ? `SapLink ${state.version}` : 'SapLink';
  renderUpdate();
  const query = $('#search').value.toLowerCase();
  const connections = state.connections.filter(c => [c.name, c.base_url, c.username, c.rfc?.ashost ?? '', c.rfc?.saprouter ?? ''].some(v => v.toLowerCase().includes(query)));
  $('#connection-count').textContent = state.connections.length;
  $('#connection-total').textContent = `${state.connections.length} 个连接`;
  $('#empty-connections').hidden = connections.length !== 0;
  $('#connections-view .table-wrap').hidden = connections.length === 0;
  const rows = $('#connection-rows'); rows.replaceChildren();
  for (const c of connections) {
    const row = element('tr');
    const name = element('td'); const identity = element('div', undefined, 'connection-identity');
    const symbol = element('span', undefined, 'connection-symbol'); symbol.append(icon(c.rfc ? 'network' : 'globe'));
    const detail = element('div'); detail.append(element('strong', c.name), element('small', `${c.rfc ? 'RFC / JCo' : 'HTTP / HTTPS'} · ${c.language}`));
    identity.append(symbol, detail); name.append(identity);
    const address = element('td'); const connectionAddress = c.rfc ? `RFC ${c.rfc.ashost} / ${c.rfc.sysnr}` : c.base_url;
    const url = element('div', connectionAddress, 'address'); url.title = connectionAddress; address.append(url);
    if (c.rfc?.saprouter) { const route = element('small', '经 SAProuter'); route.title = c.rfc.saprouter; address.append(route); }
    const login = element('td'); login.append(element('strong', c.client), element('small', c.username));
    const access = element('td'); access.append(badge(c.write_enabled ? '允许写入' : '只读', c.write_enabled ? 'writable' : 'neutral'));
    const test = element('td'); const result = tests.get(c.connection_id);
    test.append(badge(result?.label ?? '未测试', result?.kind ?? 'neutral')); if (result?.message) test.title = result.message;
    const actions = element('td'); const group = element('div', undefined, 'row-actions');
    group.append(buttonIcon('plug-zap', '测试连接', () => testConnection(c), working),
      buttonIcon('pencil', '编辑连接', () => openConnection(c), working || state.running),
      buttonIcon('trash-2', '删除连接', () => confirmAction('删除连接', `删除 ${c.name} 及其保存的凭据？`, () => act(() => api(`connections/${c.connection_id}`, 'DELETE'))), working || state.running, true));
    actions.append(group); row.append(name, address, login, access, test, actions); rows.append(row);
  }
  const tokens = $('#token-rows'); tokens.replaceChildren();
  for (const t of state.tokens) {
    const row = element('tr'); const name = element('td'); name.append(element('strong', t.name ?? '未命名令牌'));
    const actions = element('td'); const group = element('div', undefined, 'row-actions');
    group.append(buttonIcon('pencil', '修改令牌名称', () => openTokenName(t), working),
      buttonIcon('trash-2', '撤销令牌', () => confirmAction('撤销令牌', `撤销“${t.name ?? '未命名令牌'}”（创建于 ${new Date(t.created_at).toLocaleString()}）？使用此令牌的客户端将无法连接。`, () => act(() => api(`tokens/${t.id}`, 'DELETE'))), working, true));
    actions.append(group); row.append(name, element('td', new Date(t.created_at).toLocaleString()), actions); tokens.append(row);
  }
  $('#empty-tokens').hidden = state.tokens.length !== 0;
  $('#tokens-view .table-wrap').hidden = state.tokens.length === 0;
  $('#top-status').textContent = state.running ? 'MCP 运行中' : '服务未启动';
  $('#top-status').className = `badge ${state.running ? 'success' : 'neutral'}`;
  $('#service-status').textContent = state.running ? '运行中' : '已停止';
  $('#service-status').className = `badge ${state.running ? 'success' : 'neutral'}`;
  $('#start-service').hidden = state.running; $('#stop-service').hidden = !state.running;
  $('#port').disabled = working || state.running;
  if (state.running) $('#port').value = state.mcp_port;
  $('#mcp-url').textContent = `http://127.0.0.1:${$('#port').value}/mcp`;
  $('#add-connection').disabled = working || state.running; $('#empty-add').disabled = working || state.running;
  for (const selector of ['#start-service', '#stop-service', '#create-token', '#clear-cache', '#clear-logs', '#log-days']) $(selector).disabled = working;
  icons();
}
async function refresh() { state = await api('state'); render(); }
async function act(action, message = '操作完成') {
  if (working) return;
  working = true; render();
  try { const result = await action(); await refresh(); if (message) toast(message); return result; }
  catch (error) { toast(error.message, true); }
  finally { working = false; render(); }
}
function openConnection(connection) {
  editing = connection;
  const form = $('#connection-form'); form.reset(); $('#form-error').textContent = '';
  for (const control of form.elements) {
    control.setCustomValidity?.('');
    control.removeAttribute('aria-invalid');
  }
  $('#form-title').textContent = connection ? '编辑连接' : '添加连接';
  const values = connection ?? { name: '', base_url: '', client: '100', username: '', language: 'EN', write_enabled: false };
  for (const key of ['name', 'base_url', 'client', 'username', 'language']) {
    if (key === 'language' && ![...form.elements.language.options].some(o => o.value === values[key]))
      form.elements.language.append(new Option(values[key], values[key]));
    form.elements[key].value = values[key];
  }
  form.elements.write_enabled.checked = values.write_enabled;
  form.elements.transport.value = !connection || values.rfc ? 'rfc' : 'http';
  form.elements.rfc_ashost.value = values.rfc?.ashost ?? '';
  form.elements.rfc_sysnr.value = values.rfc?.sysnr ?? '';
  form.elements.rfc_saprouter.value = values.rfc?.saprouter ?? '';
  updateRfcFields();
  form.elements.password.required = !connection; $('#password-hint').hidden = !connection;
  $('#password-hint').textContent = '留空保留已保存密码；更改连接方式、目标或 SAProuter 路由时需重新输入。';
  $('#connection-dialog').showModal();
}
function confirmAction(title, message, action) {
  $('#confirm-title').textContent = title; $('#confirm-message').textContent = message;
  $('#confirm-action').onclick = () => { $('#confirm-dialog').close(); void action(); };
  $('#confirm-dialog').showModal();
}
async function testConnection(c) {
  tests.set(c.connection_id, { label: '测试中', kind: 'neutral' });
  const result = await act(() => api(`connections/${c.connection_id}/test`, 'POST'), null);
  tests.set(c.connection_id, result ? { label: '连接成功', kind: 'success' } : { label: '连接失败', kind: 'error' }); render();
}
const connectionForm = $('#connection-form');
function updateRfcFields() {
  const enabled = $('#connection-form').elements.transport.value === 'rfc';
  $('#sap-logon-import').hidden = !enabled || Boolean(editing);
  $('#rfc-fields').hidden = !enabled;
  $('#rfc-address-hint').hidden = !enabled;
  $('#saprouter-field').hidden = !enabled;
  $('#connection-url-field').hidden = enabled;
  $('#connection-form').elements.base_url.disabled = enabled;
  $('#connection-form').elements.base_url.required = !enabled;
  $('#connection-form').elements.rfc_saprouter.disabled = !enabled;
  for (const name of ['rfc_ashost', 'rfc_sysnr']) {
    $('#connection-form').elements[name].disabled = !enabled;
    $('#connection-form').elements[name].required = enabled;
  }
}
connectionForm.elements.transport.onchange = updateRfcFields;
let sapLogonConnections = [];
let sapLogonWarnings = [];
function applySapLogon(entry) {
  if (editing || connectionForm.elements.transport.value !== 'rfc' || !entry.available || !entry.rfc) return;
  const fields = connectionForm.elements;
  fields.rfc_ashost.value = entry.rfc.ashost;
  fields.rfc_sysnr.value = entry.rfc.sysnr;
  fields.rfc_saprouter.value = entry.rfc.saprouter ?? '';
  if (entry.client) fields.client.value = entry.client;
  if (entry.language) {
    if (![...fields.language.options].some(option => option.value === entry.language)) fields.language.append(new Option(entry.language, entry.language));
    fields.language.value = entry.language;
  }
  for (const name of ['rfc_ashost', 'rfc_sysnr', 'rfc_saprouter', 'client', 'language']) {
    fields[name].setCustomValidity(''); fields[name].removeAttribute('aria-invalid');
  }
  $('#form-error').textContent = '';
  $('#sap-logon-dialog').close();
  toast('已填入连接参数，请填写连接名称、用户名和密码');
}
function renderSapLogon() {
  const query = $('#sap-logon-search').value.trim().toLowerCase();
  const list = $('#sap-logon-list'); list.replaceChildren();
  const matches = sapLogonConnections.filter(entry => [entry.label, entry.system_id, entry.rfc?.ashost ?? '', entry.rfc?.saprouter ?? ''].some(value => value.toLowerCase().includes(query)));
  $('#sap-logon-status').textContent = [query ? `匹配 ${matches.length} 个连接，共 ${sapLogonConnections.length} 个。` : `找到 ${sapLogonConnections.length} 个连接，点击即可填入。`, ...sapLogonWarnings].join(' ');
  for (const entry of matches) {
    const row = element('button', undefined, 'sap-logon-entry'); row.type = 'button';
    row.disabled = !entry.available;
    row.setAttribute('aria-label', `${entry.available ? '导入' : '暂不支持'} ${entry.label}`);
    const symbol = element('span', undefined, 'sap-logon-symbol'); symbol.append(icon('server'));
    const details = element('span', undefined, 'sap-logon-details'); details.append(element('strong', entry.label));
    const address = entry.rfc ? `${entry.rfc.ashost} · 系统号 ${entry.rfc.sysnr}` : entry.reason;
    details.append(element('span', [entry.system_id, address].filter(Boolean).join(' · '), 'field-hint'));
    if (entry.rfc?.saprouter) details.append(element('span', `Router：${entry.rfc.saprouter}`, 'field-hint'));
    const action = element('span', undefined, 'sap-logon-action'); action.append(icon(entry.available ? 'arrow-right' : 'circle-slash'));
    row.onclick = () => applySapLogon(entry); row.append(symbol, details, action); list.append(row);
  }
  if (!matches.length) list.append(element('p', sapLogonConnections.length ? '没有匹配的连接。' : '未找到本地 SAP Logon 连接，可以关闭此窗口手动填写。', 'field-hint'));
  icons();
}
$('#sap-logon-search').oninput = renderSapLogon;
$('#import-sap-logon').onclick = async () => {
  if (editing || connectionForm.elements.transport.value !== 'rfc') return;
  sapLogonConnections = []; sapLogonWarnings = []; $('#sap-logon-search').value = '';
  $('#sap-logon-list').replaceChildren(); $('#sap-logon-status').textContent = '正在读取本地连接…';
  $('#sap-logon-dialog').showModal();
  $('#sap-logon-search').focus();
  try {
    const result = await api('sap-logon/connections');
    sapLogonConnections = result.connections;
    sapLogonWarnings = result.warnings;
    renderSapLogon();
  } catch (error) { $('#sap-logon-status').textContent = error.message; }
};
for (const control of connectionForm.querySelectorAll('input, select')) {
  control.addEventListener('input', () => {
    control.setCustomValidity('');
    control.removeAttribute('aria-invalid');
    $('#form-error').textContent = '';
  });
  control.addEventListener('invalid', () => {
    const hint = document.getElementById(control.getAttribute('aria-describedby'));
    const message = hint?.textContent ?? control.dataset.formatMessage ?? control.validationMessage;
    control.setCustomValidity(message);
    control.setAttribute('aria-invalid', 'true');
    $('#form-error').textContent = message;
  });
}

connectionForm.onsubmit = async event => {
  event.preventDefault(); if (working) return;
  const form = event.currentTarget; const fields = Object.fromEntries(new FormData(form));
  const data = { name: fields.name, ...(fields.transport === 'rfc' ? {} : { base_url: fields.base_url }), client: fields.client, username: fields.username,
    language: fields.language, write_enabled: form.elements.write_enabled.checked,
    ...(fields.transport === 'rfc' ? { rfc: { ashost: fields.rfc_ashost, sysnr: fields.rfc_sysnr,
      ...(fields.rfc_saprouter?.trim() ? { saprouter: fields.rfc_saprouter.trim() } : {}) } } : {}),
    ...(fields.password ? { password: fields.password } : {}) };
  working = true; render(); form.querySelector('[type=submit]').disabled = true;
  try { await api(editing ? `connections/${editing.connection_id}` : 'connections', editing ? 'PUT' : 'POST', data);
    if (editing) tests.delete(editing.connection_id); $('#connection-dialog').close(); await refresh(); toast('连接已保存'); }
  catch (error) {
    $('#form-error').textContent = error.message;
    let firstInvalidControl;
    for (const field of error.fields ?? []) {
      const control = form.elements.namedItem(field.field);
      if (!control?.setCustomValidity) continue;
      control.setCustomValidity(field.message);
      control.setAttribute('aria-invalid', 'true');
      firstInvalidControl ??= control;
    }
    firstInvalidControl?.focus();
  }
  finally { form.elements.password.value = ''; working = false; form.querySelector('[type=submit]').disabled = false; render(); }
};
for (const node of document.querySelectorAll('.close-dialog')) node.onclick = () => {
  const dialog = node.closest('dialog');
  if (dialog.id === 'token-dialog') $('#new-token').value = '';
  if (dialog.id === 'connection-dialog') $('#connection-form').elements.password.value = '';
  dialog.close();
};
$('#connection-dialog').addEventListener('close', () => { $('#connection-form').elements.password.value = ''; });
$('#token-dialog').addEventListener('close', () => { $('#new-token').value = ''; });
for (const node of document.querySelectorAll('.nav')) node.onclick = () => {
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== `${node.dataset.view}-view`;
  for (const item of document.querySelectorAll('.nav')) item.classList.toggle('active', item === node);
  $('#breadcrumb').textContent = labels[node.dataset.view];
};
$('#add-connection').onclick = $('#empty-add').onclick = () => openConnection();
$('#search').oninput = render;
$('#port').oninput = () => { $('#mcp-url').textContent = `http://127.0.0.1:${$('#port').value}/mcp`; };
let editingToken;
function openTokenName(token) {
  editingToken = token;
  $('#token-name-form').reset(); $('#token-name-error').textContent = '';
  $('#token-name-title').textContent = token ? '修改令牌名称' : '创建访问令牌';
  $('#token-name-submit').textContent = token ? '保存名称' : '创建令牌';
  $('#token-name').value = token?.name ?? '';
  $('#token-name-dialog').showModal(); $('#token-name').focus();
}
$('#create-token').onclick = () => openTokenName();
let environmentBusy = false;
function renderRfcEnvironment(result) {
  const detected = result.detected ?? { java: result.java, jco_jar: result.jar };
  const source = { settings: '已保存', environment: '环境变量', bundled: '安装包自带', system: '本机检测' };
  $('#rfc-java-detected').textContent = detected.java ? `${source[detected.java.source]}：${detected.java.path}` : '尚未找到 Java';
  $('#rfc-jco-detected').textContent = detected.jco_jar ? `${source[detected.jco_jar.source]}：${detected.jco_jar.path}` : '尚未找到 JCo';
  const checks = $('#rfc-environment-checks'); checks.replaceChildren();
  for (const check of result.checks ?? []) {
    const row = element('div', undefined, `environment-check ${check.passed ? 'success' : 'error'}`);
    row.append(icon(check.passed ? 'circle-check' : 'circle-alert'), element('span', check.message)); checks.append(row);
  }
  $('#rfc-environment-status').textContent = result.versions ? `Java ${result.versions.java} · ${result.versions.architecture} · JCo ${result.versions.jco}` : '';
  icons();
}
async function openRfcEnvironment() {
  $('#rfc-environment-error').textContent = '';
  $('#rfc-environment-status').textContent = '正在检测本机路径…';
  $('#rfc-environment-checks').replaceChildren();
  $('#rfc-environment-form').reset();
  $('#rfc-environment-dialog').showModal();
  try {
    const result = await api('rfc/environment');
    for (const name of ['java_home', 'jco_directory']) $('#rfc-environment-form').elements[name].value = result.settings[name] ?? '';
    renderRfcEnvironment(result);
    $('#save-rfc-environment').disabled = state.running;
    if (state.running) $('#rfc-environment-status').textContent = 'MCP 正在运行，可检查环境；更改路径前请先停止 MCP。';
  } catch (error) { $('#rfc-environment-error').textContent = error.message; }
}
$('#open-rfc-environment').onclick = openRfcEnvironment;
$('#open-rfc-environment-service').onclick = openRfcEnvironment;
async function verifyRfcEnvironment(save) {
  if (environmentBusy) return;
  environmentBusy = true; $('#rfc-environment-error').textContent = '';
  $('#check-rfc-environment').disabled = $('#save-rfc-environment').disabled = true;
  $('#rfc-environment-status').textContent = '正在加载 Java 和 JCo…';
  try {
    if (save) {
      const fields = $('#rfc-environment-form').elements;
      await api('rfc/environment', 'PUT', Object.fromEntries(['java_home', 'jco_directory'].map(name => [name, fields[name].value.trim()]).filter(([, value]) => value)));
    }
    renderRfcEnvironment(await api('rfc/environment/check', 'POST', {}));
  } catch (error) { $('#rfc-environment-error').textContent = error.message; $('#rfc-environment-status').textContent = ''; }
  finally { environmentBusy = false; $('#check-rfc-environment').disabled = false; $('#save-rfc-environment').disabled = state.running; }
}
$('#rfc-environment-form').onsubmit = event => { event.preventDefault(); void verifyRfcEnvironment(true); };
$('#check-rfc-environment').onclick = () => verifyRfcEnvironment(false);
$('#token-name-form').onsubmit = async event => {
  event.preventDefault(); if (working) return;
  const name = $('#token-name').value.trim();
  $('#token-name-error').textContent = '';
  working = true; render(); $('#token-name-submit').disabled = true;
  try {
    const result = await api(editingToken ? `tokens/${editingToken.id}` : 'tokens', editingToken ? 'PUT' : 'POST', { name });
    $('#token-name-dialog').close();
    if (!editingToken) {
      $('#created-token-name').textContent = result.name;
      $('#new-token').value = `Bearer ${result.token}`; $('#token-dialog').showModal();
    } else toast('令牌名称已更新');
    await refresh();
  } catch (error) {
    if ($('#token-name-dialog').open) $('#token-name-error').textContent = error.message;
    else toast(error.message, true);
  } finally { working = false; $('#token-name-submit').disabled = false; render(); }
};
$('#start-service').onclick = () => act(() => api('service/start', 'POST', { port: Number($('#port').value) }), 'MCP 服务已启动');
$('#clear-cache').onclick = async () => {
  const result = await act(() => api('cache/clear', 'POST'), null);
  if (result) { tests.clear(); render(); toast(`已清理 ${result.cleared_sessions} 个连接缓存，保留 ${result.retained_write_requests} 条写入防重复记录`); }
};
$('#clear-logs').onclick = async () => {
  if (!$('#log-days').reportValidity()) return;
  const days = Number($('#log-days').value);
  const preview = await act(() => api('logs/clear', 'POST', { older_than_days: days, confirm: false }), null);
  if (!preview) return;
  if (preview.failed_files) { toast('部分日志无法检查，请检查文件权限后重试。', true); return; }
  if (!preview.eligible_files) { toast('没有符合条件的历史日志，当天日志已保留。'); return; }
  confirmAction('删除历史日志', `将永久删除 ${preview.eligible_files} 个历史日志文件，共 ${preview.eligible_bytes.toLocaleString()} 字节。当天日志和最近 ${days} 天的日志会保留。此操作无法撤销，是否继续？`, async () => {
    const result = await act(() => api('logs/clear', 'POST', { older_than_days: days, confirm: true }), null);
    if (result) toast(`已删除 ${result.deleted_files} 个日志文件，释放 ${result.deleted_bytes.toLocaleString()} 字节${result.failed_files ? `；${result.failed_files} 个文件清理失败` : ''}`, result.failed_files > 0);
  });
};
$('#stop-service').onclick = () => confirmAction('停止 MCP 服务', '等待正在执行的操作结束后停止服务？', () => act(() => api('service/stop', 'POST'), 'MCP 服务已停止'));
async function copy(value) { try { await navigator.clipboard.writeText(value); toast('已复制'); } catch { toast('复制失败，请手动选择内容', true); } }
$('#copy-url').onclick = () => copy($('#mcp-url').textContent);
$('#copy-token').onclick = () => copy($('#new-token').value);
icons();
if (!adminKey) $('#locked').hidden = false;
else refresh().catch(error => toast(error.message, true));

setInterval(async () => {
  if (!adminKey || document.hidden) return;
  try {
    const latest = await api('state');
    const changed = state.running !== latest.running || state.mcp_port !== latest.mcp_port || state.busy !== latest.busy;
    state.running = latest.running; state.mcp_port = latest.mcp_port; state.busy = latest.busy;
    state.update = latest.update; state.update_install = latest.update_install;
    if (changed) render(); else renderUpdate();
  }
  catch { /* Existing page actions report session and connection failures. */ }
}, 3000);
