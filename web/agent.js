/* SAP Agent UI: sanitized Markdown and actual execution events. */
(() => {
  const view = $('#agent-view');
  const chatScroll = $('#agent-chat-scroll'), scrollBottom = $('#agent-scroll-bottom');
  function updateScrollBottom() {
    scrollBottom.hidden = !chatScroll.clientHeight || chatScroll.scrollHeight-chatScroll.clientHeight-chatScroll.scrollTop<=40;
  }
  chatScroll.addEventListener('scroll',()=>{
    updateScrollBottom();
    loadEarlierAtTop();
  },{passive:true});
  const chatSize = new ResizeObserver(updateScrollBottom);
  for (const node of [chatScroll,...chatScroll.children]) chatSize.observe(node);
  scrollBottom.onclick = () => chatScroll.scrollTo({
    top:chatScroll.scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'
  });
  let modelStatus, connections = [], selectedTask, taskList = [], busy = false;
  let timer, pollRunning = false, generation = 0;
  let errorFromPolling = false;
  let activityKey,activityTurn,activityWasActive=false;
  let reportTaskId, reportValue, reportLoading = false, reportDrawKey;
  let currentReportId,reportRequest=0;
  const reportChoices=new Map(),reportHeads=new Map();
  const reportTabs=new Map();
  let chatTaskId, chatMessages = [], chatCursor, earlierRequest;
  let streamSession, displayedDraft, streamNotice='';
  let manageMode, managedTask, managedReport, cleanupCandidates = [], manageRevision = 0;
  let editingTitle,selectionTimer;
  let sessionLoading = false, sessionDetailLoading = false, sessionLoadFailed = false;
  let draftView, draftWorking = false, draftRequest = 0;
  let changeHistoryTaskId, changeHistoryKey;
  let historicalCreations = [];
  let cardActionPending = false;
  let planView;
  let localScriptView, localScriptWorking = false, localWorkKey;
  const isPlanItem = record => record.kind !== 'operation' ||
    ['create_program','create_ddic_object','create_function_group','create_function_module'].includes(record.p.tool);
  const isDdicUri = uri => /^\/sap\/bc\/adt\/ddic\/(?:tables|structures)\//i.test(uri??'');
  const isDdicDraft = proposal => proposal.tool==='create_ddic_object'||isDdicUri(proposal.object_uri??proposal.plan?.object_uri);
  const draftObject = proposal => proposal.object_label ?? proposal.object_uri?.split('/').filter(Boolean).at(-1);
  let pendingUploads = [];
  let pendingReferences = [];
  let pendingWebsites = [];
  function cancelSessionSelection(){clearTimeout(selectionTimer);selectionTimer=undefined;}
  const connectionPreference = 'saplink.agent.connection';
  const taskPreference = 'saplink.agent.task';
  function taskPreferenceKey(connectionId = $('#agent-connection').value) { return taskPreference + ':' + connectionId; }
  function rememberedTask() { try { return sessionStorage.getItem(taskPreferenceKey()); } catch { return null; } }
  function rememberTask() {
    try { if (selectedTask) sessionStorage.setItem(taskPreferenceKey(selectedTask.connection_id),selectedTask.id); else sessionStorage.setItem(taskPreferenceKey(),'new'); } catch {}
  }
  function rememberedConnection() {
    try { return localStorage.getItem(connectionPreference); } catch { return null; }
  }
  function rememberConnection() {
    const id = $('#agent-connection').value;
    try {
      if (id) localStorage.setItem(connectionPreference, id);
      else localStorage.removeItem(connectionPreference);
    } catch { /* Connection selection still works when storage is unavailable. */ }
  }
  const terminal = task => task && !['queued', 'running'].includes(task.status);
  const names = { queued: '等待执行', running: '分析中', waiting_input:'等待你的回答', completed: '已完成', failed: '分析失败', stopped: '已停止', interrupted: '待恢复' };
  const modelNames = { 'deepseek-flash': 'DeepSeek Flash', 'deepseek-v4-pro': 'DeepSeek V4 Pro' };
  const toolNames = { remember_for_future:'整理长期记忆', web_search:'联网搜索', read_web_page:'读取网页', read_skill_file:'读取技能文件', draft_skill_package:'生成技能包', propose_local_script:'准备本地脚本', create_local_document:'生成文档', list_custom_mcp_tools:'列出自定义 MCP 工具', call_custom_mcp_tool:'调用自定义 MCP', inspect_mcp_services:'检查 MCP 服务', propose_mcp_change:'准备 MCP 变更',
    get_capabilities: '验证系统能力', search_objects: '搜索业务对象', list_package_objects: '浏览开发包',
    read_source: '读取源码', get_ddic_definition: '读取字段结构', get_data_element: '读取字段语义', get_domain_values: '读取域值',
    get_odata_service_binding: '读取 OData 服务绑定',
    find_references: '查找引用关系', find_definition: '定位定义', get_class_structure: '读取类结构', get_type_hierarchy: '读取类型关系',
    search_enhancements: '查找增强', list_source_versions: '读取历史版本', compare_source_versions: '比较源码版本',
    list_function_group_members: '读取函数组成员', get_function_group: '读取函数组', query_table: '读取表数据', query_sql: '只读 SQL 查询' };
  toolNames.read_task_artifact = '回读任务原始资料';
  toolNames.create_report='生成分析报告';toolNames.update_report='更新分析报告';
  toolNames.propose_source_change='生成源码变更草稿';
  toolNames.propose_controlled_operation='生成受控操作草稿';
  toolNames.propose_program_workflow='生成任务计划';
  toolNames.get_atc_configuration='读取 ATC 配置';
  toolNames.list_transport_requests='读取传输请求';
  const operationNames = { create_program:'创建程序或 Include', create_ddic_object:'创建字典对象', create_function_group:'创建函数组',
    create_function_module:'创建函数模块', create_transport_request:'创建传输请求', activate_objects:'联合激活', run_atc:'执行 ATC', run_unit_tests:'执行 ABAP Unit' };
  function connectionLabel(c) { return `${c.name} · Client ${c.client}`; }
  function chosenWriteMode() {
    const id = $('#agent-connection').value;
    if (!connections.find(item => item.connection_id === id)?.write_enabled) return 'controlled';
    if (selectedTask?.connection_id === id) return selectedTask.write_mode ?? 'controlled';
    try { return localStorage.getItem('saplink.agent.write-mode:' + id) === 'unrestricted' ? 'unrestricted' : 'controlled'; }
    catch { return 'controlled'; }
  }
  function renderWriteMode() {
    const enabled = connections.find(item => item.connection_id === $('#agent-connection').value)?.write_enabled;
    const button = $('#agent-write-mode'), full = chosenWriteMode() === 'unrestricted';
    button.hidden = !enabled; button.classList.toggle('write-full', full);
    $('#agent-write-mode span').textContent = full ? '完全写入' : '受控写入';
    button.setAttribute('aria-label', '客户端写入权限：' + (full ? '完全写入' : '受控写入'));
    if (!enabled && $('#agent-write-menu').matches(':popover-open')) $('#agent-write-menu').hidePopover();
  }
  function renderAnswer(text, node = $('#agent-answer')) {
    window.SapLinkMarkdown.render(text,node);
  }
  function renderChanges() {
    const list = $('#agent-change-list');
    const history = $('#agent-change-history-dialog');
    if (history.open && changeHistoryTaskId !== selectedTask?.id) history.close();
    if (planView && planView.taskId !== selectedTask?.id) {
      $('#agent-draft-plan-dialog').close();
      planView = undefined;
    }
    if (draftView && draftView.taskId !== selectedTask?.id) {
      $('#agent-draft-dialog').close(); $('#agent-activate-dialog').close(); draftView = undefined; draftRequest++;
    }
    const entries = [
      ...(selectedTask?.changes ?? []).map(p=>({kind:'change',p,title:p.summary})),
      ...(selectedTask?.workflow_proposals ?? []).map(p=>({kind:'workflow',p,title:p.summary ?? (p.action==='create_program'?'创建程序':'修改源码')})),
      ...(selectedTask?.operation_proposals ?? []).map(p=>({kind:'operation',p,title:operationNames[p.tool]??p.tool}))
    ];
    const records = entries.map(entry => ({
      ...entry,
      state: selectedTask?.drafts?.find(d => d.key === entry.kind + ':' + entry.p.id)
    })).sort((a, b) => b.p.created_at.localeCompare(a.p.created_at));
    const predecessors = new Map();
    for (const record of [...records].reverse()) {
      if (record.state?.replacement_id && !predecessors.has(record.state.replacement_id))
        predecessors.set(record.state.replacement_id, record.p.id);
    }
    const existing = new Map([...list.children].map(node => [node.dataset.cardKey, node]));
    const createdAt = new Map(records.map(record => [record.p.id, record.p.created_at]));
    const cards = [];
    const planMembers = selectedTask?.draft_plan_members ?? [];
    const planRecords = records.filter(record => isPlanItem(record) && (
      !['saved','discarded','superseded'].includes(record.state?.state) ||
      record.state?.state === 'saved' && planMembers.includes(record.kind + ':' + record.p.id)));
    const grouped = planRecords.length > 1 && planRecords.some(record => record.state?.state !== 'saved');
    const manifest = planRecords.map(record => [record.kind + ':' + record.p.id, record.p.artifact_id, record.state?.state ?? 'pending']);
    for (const {kind,p,title,state} of records) {
      if (['saved', 'discarded', 'superseded'].includes(state?.state)) continue;
      if (grouped && isPlanItem({kind,p})) continue;
      let root = p.id;
      const visited = new Set([root]);
      while (predecessors.has(root) && !visited.has(predecessors.get(root))) {
        root = predecessors.get(root);
        visited.add(root);
      }
      const key = selectedTask.id + ':' + root;
      const card = existing.get(key) ?? createDraftCard(key);
      const [summary, actions] = card.children;
      const [label, heading] = summary.children;
      label.textContent = state?.state === 'conflict' ? '等待你确认'
        : state ? draftLabel(state) : '待保存的修改';
      heading.textContent = title;
      summary.onclick = () => void openDraft(kind, p.id);
      for (const button of actions.children) {
        button.onclick = () => void runCardAction(kind, p.id, button.dataset.action);
      }
      card.dataset.state = state?.state ?? '';
      card.dataset.legacy = String(Boolean(state?.legacy || (state?.state === 'failed' && state.created_program)));
      card.dataset.draftId = p.id;
      card.dataset.createdAt = createdAt.get(root);
      cards.push(card);
    }
    cards.sort((a, b) => b.dataset.createdAt.localeCompare(a.dataset.createdAt));
    if (grouped) {
      const key = selectedTask.id + ':plan';
      const card = existing.get(key) ?? createDraftCard(key);
      const [summary, actions] = card.children;
      const [label, heading] = summary.children;
      const done = planRecords.filter(record => record.state?.state === 'saved').length;
      label.textContent = done ? `已保存 ${done} 项 · 剩余 ${planRecords.length - done} 项` : '待保存的修改';
      heading.textContent = `修改计划 · ${planRecords.length} 项`;
      summary.onclick = () => void openDraftPlan(manifest);
      for (const button of actions.children) button.onclick = () => void openDraftPlan(manifest, button.dataset.action);
      card.dataset.state = planRecords.some(record => ['saving','uncertain','conflict'].includes(record.state?.state)) ? 'conflict' : '';
      cards.unshift(card);
    }
    const seenSources = new Set();
    const saved = records.filter(record => record.state?.saved_source && record.state.state === 'saved')
      .sort((a, b) => (b.state.saved_at ?? b.state.updated_at).localeCompare(a.state.saved_at ?? a.state.updated_at));
    for (const {kind,p,state} of saved) {
      const {object_uri} = state.saved_source;
      if (seenSources.has(object_uri)) continue;
      seenSources.add(object_uri);
      if (state.activation) continue;
      if (grouped && planMembers.includes(kind + ':' + p.id)) continue;
      const button = element('button', '待激活 · ' + object_uri.split('/').filter(Boolean).at(-1));
      button.type = 'button';
      button.onclick = () => void openDraft(kind, p.id, true);
      cards.push(button);
    }
    for (let i = 0; i < cards.length; i++) {
      if (list.children[i] !== cards[i]) list.insertBefore(cards[i], list.children[i] ?? null);
    }
    while (list.children.length > cards.length) list.lastElementChild.remove();
    updateCardControls();
    $('#agent-change-history').hidden = !selectedTask || sessionDetailLoading || sessionLoadFailed;
    if (history.open) renderChangeHistory(records);
    if (draftView && $('#agent-draft-dialog').open && !draftWorking) {
      const current = records.find(record => record.kind === draftView.kind && record.p.id === draftView.id)?.state;
      if (current && current.updated_at !== draftView.detail.draft?.updated_at &&
          ['superseded','conflict','saved','discarded'].includes(current.state)) {
        draftView.detail.draft = current;
        draftView.detail.can_save = false;
        draftView.detail.can_discard = current.state === 'conflict';
        renderDraftState();
      }
    }
    list.hidden=!list.childElementCount||sessionDetailLoading||sessionLoadFailed;
    if(draftView?.detail.draft?.state==='saving'&&!draftWorking&&$('#agent-draft-dialog').open) {
      const v=draftView;
      draftWorking=true;
      void api(draftPath(v)).then(detail=>{
        if(v!==draftView)return;
        v.detail=detail;renderDraftState();
      }).catch(error=>{if(v===draftView)$('#agent-draft-status').textContent=error.message;})
        .finally(()=>{draftWorking=false;draftControls();});
    }
  }
  function createDraftCard(key) {
    const card = element('article', undefined, 'agent-draft-card agent-draft-review-card');
    card.dataset.cardKey = key;
    const summary = element('button', undefined, 'agent-draft-card-summary');
    summary.type = 'button';
    summary.setAttribute('aria-haspopup', 'dialog');
    summary.append(element('small', undefined, 'agent-draft-card-state'),
      element('span', undefined, 'agent-draft-card-title'));
    const actions = element('div', undefined, 'agent-draft-card-actions');
    for (const [action, label] of [['save','保存'], ['discard','作废']]) {
      const button = element('button', label, action === 'save' ? 'primary' : undefined);
      button.type = 'button';
      button.dataset.action = action;
      actions.append(button);
    }
    card.append(summary, actions);
    return card;
  }
  function updateCardControls() {
    const locked = busy || cardActionPending || draftWorking || Boolean(modelStatus?.active_task_id);
    const writable = connections.some(connection => connection.connection_id === selectedTask?.connection_id && connection.write_enabled);
    for (const card of document.querySelectorAll('.agent-draft-review-card')) {
      const {state, legacy} = card.dataset;
      card.querySelector('.agent-draft-card-summary').disabled = cardActionPending || draftWorking;
      for (const button of card.querySelectorAll('[data-action]')) {
        button.disabled = locked || state === 'saving' ||
          (button.dataset.action === 'save' && (!writable || Boolean(state && !(legacy === 'true' && state === 'failed')))) ||
          (button.dataset.action === 'discard' && state === 'uncertain');
      }
    }
    if (planView) for (const button of document.querySelectorAll('[data-plan-action]')) {
      const action = button.dataset.planAction;
      button.disabled = locked || (action === 'save' && (!writable || !planView.plan.can_save)) ||
        (action === 'discard' && !planView.plan.can_discard);
    }
  }
  function creationSummary(proposal) {
    const tool = proposal.plan?.action ?? proposal.tool;
    const input = proposal.plan ?? proposal.intent?.input;
    if (!input || !['create_program','create_ddic_object','create_function_group','create_function_module'].includes(tool)) return;
    const type = tool === 'create_ddic_object' ? (input.ddic_kind==='table'?'数据库表':'字典结构')
      : tool === 'create_function_group' ? '函数组' : tool === 'create_function_module' ? '函数模块'
      : ({report:'ABAP 报表', include:'Include 程序', module_pool:'模块池程序',
          subroutine_pool:'子例程池程序'}[input.program_kind ?? 'report'] ?? 'ABAP 程序');
    const group = input.function_group_uri?.split('/').filter(Boolean).at(-1)?.toUpperCase();
    const fields = [
      ['描述',input.description],
      ['开发包',input.package_name === '$TMP' ? '$TMP（本地对象）' : input.package_name],
      ['所属函数组',group],
      ['传输任务',input.transport_task],
      ['初始源码',input.source?.trim() ? '包含初始源码' : tool === 'create_function_group' ? undefined : '仅创建对象，不写入自定义源码']
    ];
    return {title:`新建 ${type} ${input.name}`,fields};
  }
  function creationFields(creation) {
    const list = element('dl',undefined,'draft-creation-fields');
    for (const [label,value] of creation.fields) {
      if (value) list.append(element('dt',label),element('dd',value));
    }
    return list;
  }
  function renderDraftPlan() {
    const list = $('#agent-draft-plan-items');
    const collapsed = new Set([...list.querySelectorAll('details:not([open])')].map(item => item.dataset.key));
    list.replaceChildren();
    for (const item of planView.plan.items) {
      const proposal = item.proposal;
      const detail = element('details');
      detail.dataset.key = item.key;
      detail.open = !collapsed.has(item.key);
      const title = proposal.summary ?? operationNames[proposal.tool] ?? (proposal.plan?.action === 'create_program' ? '创建程序' : '修改源码');
      const name = draftObject(proposal) ?? proposal.plan?.name ?? proposal.intent?.input?.name;
      const creation = creationSummary(proposal);
      const header = element('summary');
      header.append(element('strong',creation?.title ?? name ?? title),
        element('span',draftLabel({state:item.state}),'badge neutral'));
      detail.append(header);
      if (creation) detail.append(creationFields(creation));
      else if (name && name !== title) detail.append(element('p',title,'draft-plan-description'));
      if (item.message) detail.append(element('p',item.message,'field-hint'));
      if (item.can_reconcile) {
        const verify = element('button','核实保存结果');
        verify.type = 'button';
        verify.onclick = () => confirmSourceResult(planView.taskId,item.kind,item.id,item.artifact_id);
        detail.append(verify);
      }
      const diff = reviewDiff(proposal,item.diff);
      if (!creation || proposal.plan?.source?.trim() || proposal.tool==='create_ddic_object') {
        if (diff) detail.append(draftDiff(diff,creation ? '新增源码' : '代码差异'));
        if (!diff || diff.truncated) {
          const content = proposal.proposed_source ?? proposal.plan?.source ?? proposal.intent?.input?.source ?? JSON.stringify(proposal.intent?.input,null,2);
          detail.append(element('pre',content,'draft-code'));
        }
      }
      list.append(detail);
    }
    updateCardControls();
  }
  function reviewDiff(proposal, diff) {
    diff ??= proposal.diff;
    if (diff) return diff;
    const source = proposal.tool==='create_ddic_object' ? proposal.intent?.input?.source
      : proposal.plan?.action==='create_program' ? proposal.plan.source : undefined;
    if (!source?.trim()) return;
    // A new object has no old source. Older responses may omit its preview.
    const lines = source.replace(/\r\n?/g,'\n').split('\n');
    const preview = lines.slice(0,2000).map((text,index) => ({
      kind:'added',new_line:index+1,text:text.slice(0,4000),text_truncated:text.length>4000
    }));
    return {added_lines:lines.length,removed_lines:0,hunks:[{lines:preview}],
      truncated:preview.length<lines.length || preview.some(line => line.text_truncated)};
  }
  function draftDiff(diff, title = '代码差异') {
    const view = element('section',undefined,'draft-diff');
    const header = element('div',undefined,'draft-diff-heading');
    header.append(element('strong',title), element('span','+' + diff.added_lines,'draft-diff-added'),
      element('span','−' + diff.removed_lines,'draft-diff-removed'));
    view.append(header);
    const truncation = '差异预览已截断，可在下方查看完整拟保存源码。';
    if (!diff.hunks.length) {
      const note = diff.truncated ? truncation : diff.line_endings_only ? '仅换行符格式变化。' : '没有源码行变化。';
      view.append(element('p',note,'draft-diff-note'));
      return view;
    }
    const scroll = element('div',undefined,'draft-diff-scroll');
    const table = element('table');
    const headings = table.createTHead().insertRow();
    for (const label of ['旧行','新行','差异','源码']) {
      const heading = element('th',label);
      heading.scope = 'col';
      headings.append(heading);
    }
    const body = table.createTBody();
    for (const [index,hunk] of diff.hunks.entries()) {
      if (index) {
        const gap = body.insertRow().insertCell();
        gap.colSpan = 4;
        gap.className = 'draft-diff-gap';
        gap.textContent = '⋯ 省略未修改行';
      }
      for (const line of hunk.lines) {
        const row = body.insertRow();
        row.className = 'draft-diff-' + line.kind;
        row.insertCell().textContent = line.old_line ?? '';
        row.insertCell().textContent = line.new_line ?? '';
        row.insertCell().textContent = {added:'+',removed:'−'}[line.kind] ?? '';
        row.insertCell().textContent = line.text + (line.text_truncated ? '…' : '');
      }
    }
    scroll.append(table);
    view.append(scroll);
    if (diff.truncated) view.append(element('p',truncation,'draft-diff-note'));
    return view;
  }
  async function openDraftPlan(manifest, action) {
    if (cardActionPending || draftWorking || !selectedTask) return;
    const taskId = selectedTask.id;
    cardActionPending = true;
    updateCardControls();
    try {
      const plan = await api(`agent/tasks/${taskId}/draft-plan`);
      if (selectedTask?.id !== taskId) return;
      planView = {taskId, plan};
      $('#agent-draft-plan-status').textContent = '';
      $('#agent-draft-plan-items').replaceChildren();
      renderDraftPlan();
      const current = plan.items.map(item => [item.key,item.artifact_id,item.state]);
      const reviewDdic = action==='save' && plan.items.some(item=>item.state!=='saved'&&isDdicDraft(item.proposal));
      if (action && !reviewDdic && JSON.stringify(current.sort()) === JSON.stringify([...manifest].sort()) &&
          plan['can_' + action]) await actOnDraftPlan(action);
      else $('#agent-draft-plan-dialog').showModal();
    } catch (error) { toast(error.message,true); }
    finally { cardActionPending = false; updateCardControls(); }
  }
  const saveDialog = $('#agent-draft-save-dialog');
  let saveView;
  function openDraftSave(taskId,items,single) {
    saveView = {taskId,items,single,steps:{},state:'running'};
    if (single) saveView.steps[items[0].key] = 'processing';
    $('#agent-draft-save-error').textContent = '';
    renderDraftSave(); saveDialog.showModal();
  }
  function renderDraftSave() {
    const {items,steps,state,failure} = saveView;
    const saved = items.filter(item=>item.state==='saved' || steps[item.key]==='saved').length;
    const result = $('#agent-draft-save-result');
    if (result.dataset.state!==state) {
      result.dataset.state = state;
      result.querySelector('.draft-save-glyph').replaceChildren(icon(state==='running'?'loader-circle':state==='saved'?'check':'circle-alert'));
    }
    const summary = result.querySelector('.draft-save-summary');
    const title = state==='running'?'正在保存':state==='saved'?'保存成功':state==='unknown'?'保存结果待核实':'保存未完成';
    const message = failure?.message || saveView.message;
    if (summary.firstElementChild?.textContent!==title || (summary.querySelector('p')?.textContent ?? '')!==(message ?? ''))
      summary.replaceChildren(element('strong',title),...(message?[element('p',message)]:[]));
    const count = result.querySelector('.draft-save-count');
    const savedCount = `已保存 ${saved}/${items.length} 项`;
    if (count.textContent!==savedCount) count.textContent = savedCount;
    const labels = {checking:'校验基线',ready:'校验通过',saving:'正在保存',processing:'检查并保存',saved:'已保存',failed:'保存失败',uncertain:'待核实',
      waiting:state==='running'?'等待处理':'未继续处理'};
    $('#agent-draft-save-steps').replaceChildren(...items.map(item=>{
      const stage = item.state==='saved' || steps[item.key]==='saved' ? 'saved' : failure?.key===item.key ?
        item.state==='uncertain'?'uncertain':'failed' : state==='running' ? steps[item.key] ?? 'waiting' : 'waiting';
      const row = element('li');
      row.dataset.stage = stage;
      const badge = element('span',labels[stage] ?? labels.waiting,'draft-save-step-status');
      row.append(icon('file-code'),element('strong',item.label ?? draftObject(item.proposal) ?? item.proposal.plan?.name ?? 'SAP 对象'),badge);
      return row;
    }));
    const review = $('#agent-draft-save-review');
    review.hidden = !['failed','unknown'].includes(state);
    review.textContent = saveView.single ? '查看修改' : '查看修改计划';
    $('#agent-draft-save-regenerate').hidden = !saveView.regenerateId;
    $('#agent-draft-save-actions').hidden = review.hidden && !saveView.regenerateId;
    $('#agent-draft-save-close').disabled = state==='running';
    updateDraftSaveControls();
    icons();
  }
  function updateDraftSaveControls() {
    $('#agent-draft-save-review').disabled = draftWorking || Boolean(saveView?.regenerating);
    $('#agent-draft-save-regenerate').disabled = draftWorking || Boolean(saveView?.regenerating);
  }
  async function pollDraftSave(view) {
    try {
      const steps = await api(`agent/tasks/${view.taskId}/draft-plan/progress`);
      if (saveView===view && view.state==='running') { Object.assign(view.steps,steps); renderDraftSave(); }
    } catch { /* The save request supplies the final result. */ }
  }
  async function actOnDraftPlan(action) {
    if (!planView || draftWorking) return;
    const current = planView;
    draftWorking = true;
    updateCardControls();
    const dialog = $('#agent-draft-plan-dialog');
    let progressTimer;
    if (action === 'save') {
      if (dialog.open) dialog.close();
      openDraftSave(current.taskId,current.plan.items);
      const view = saveView;
      progressTimer = setInterval(()=>void pollDraftSave(view),500);
    }
    try {
      const result = await api(`agent/tasks/${current.taskId}/draft-plan/${action}`,'POST',{
        confirm:true,token:current.plan.token,...(action==='save'?{manual_recovery:true}:{})
      });
      if (current !== planView && action!=='save') return;
      if (action === 'save') {
        current.plan = result.plan;
        if (current===planView) renderDraftPlan();
        saveView.items = result.plan.items;
        saveView.failure = result.failure;
        saveView.regenerateId = result.regenerate_id;
        saveView.state = result.failure ? 'failed' : 'saved';
        renderDraftSave();
      } else dialog.close();
      await poll();
    } catch (error) {
      if (action==='save' && saveView?.state==='running') {
        saveView.state = 'unknown';
        saveView.failure = {message:error.message};
        renderDraftSave();
      } else if (dialog.open) $('#agent-draft-plan-status').textContent = error.message;
      else toast(error.message,true);
    } finally { clearInterval(progressTimer); draftWorking = false; updateCardControls(); updateDraftSaveControls(); }
  }
  $('#agent-draft-save-close').onclick = () => { if (saveView?.state!=='running' && !saveView?.regenerating) saveDialog.close(); };
  saveDialog.addEventListener('cancel',event=>{if (saveView?.state==='running' || saveView?.regenerating) event.preventDefault();});
  $('#agent-draft-save-review').onclick = async () => {
    if (!saveView || draftWorking || selectedTask?.id!==saveView.taskId) return;
    saveDialog.close();
    if (saveView.single) {
      const {kind,id} = saveView.single;
      if (!$('#agent-draft-dialog').open) await openDraft(kind,id);
    } else await openDraftPlan();
  };
  $('#agent-draft-save-regenerate').onclick = async () => {
    const current = saveView;
    if (!current?.regenerateId || current.regenerating || draftWorking || selectedTask?.id!==current.taskId) return;
    const label = $('#agent-draft-save-regenerate span'), error = $('#agent-draft-save-error');
    current.regenerating = true;
    label.textContent = '正在提交…'; error.textContent = '';
    $('#agent-draft-save-close').disabled = true;
    updateDraftSaveControls();
    try {
      const task = await api(`agent/tasks/${current.taskId}/draft-regenerate`,'POST',{regenerate_id:current.regenerateId});
      if (selectedTask?.id!==current.taskId) return;
      generation++;
      selectedTask = task;
      taskList = taskList.map(entry=>entry.id===task.id?task:entry);
      $('#agent-draft-dialog').close();
      saveDialog.close();
      renderHistory(); renderTask(); updateControls();
      await loadConversation();
      await poll();
    } catch (failure) { error.textContent = failure.message; }
    finally {
      current.regenerating = false; label.textContent = '重新生成草稿';
      $('#agent-draft-save-close').disabled = false;
      updateDraftSaveControls();
    }
  };
  $('#agent-draft-plan-close').onclick = () => { if (!draftWorking) $('#agent-draft-plan-dialog').close(); };
  $('#agent-draft-plan-dialog').addEventListener('cancel', event => { if (draftWorking) event.preventDefault(); });
  for (const button of document.querySelectorAll('[data-plan-action]')) button.onclick = () => void actOnDraftPlan(button.dataset.planAction);
  async function runCardAction(kind, id, action) {
    if (cardActionPending || draftWorking) return;
    cardActionPending = true;
    updateCardControls();
    try {
      if (await openDraft(kind, id, false, true)) {
        if (['saved','discarded','superseded'].includes(draftView.detail.draft?.state) ||
            (action === 'save' && (!draftView.detail.can_save || isDdicDraft(draftView.detail.proposal))) ||
            (action === 'discard' && !draftView.detail.can_discard)) {
          $('#agent-draft-dialog').showModal();
        } else await draftAction(action);
      }
    } finally {
      cardActionPending = false;
      updateCardControls();
    }
  }
  function draftLabel(state) {
    if (state?.state === 'saved') return state.activation === 'completed' ? '已激活'
      : state.activation === 'uncertain' ? '激活待核实'
      : state.activation === 'failed' ? '激活失败'
      : state.activation === 'running' ? '激活中'
      : state.saved_source ? '已保存，待激活' : '已保存';
    return {saving:'保存中', discarded:'已作废', failed:'保存失败', uncertain:'待核实', superseded:'已更新', conflict:'待合并'}[state?.state] ?? '待保存';
  }
  function renderChangeHistory(records) {
    const creations = new Map(historicalCreations.map(receipt => [receipt.object_uri + receipt.completed_at,receipt]));
    const recordKey = ({kind,p}) => kind + ':' + p.id;
    for (const record of records) {
      const {state} = record;
      const receipt = state?.created_program;
      if (receipt && state.state !== 'saved') {
        creations.set(receipt.object_uri + receipt.completed_at,{...receipt,draft_key:recordKey(record)});
      }
    }
    const groups = [...(selectedTask.draft_plan_history ?? [])];
    const activeMembers = selectedTask.draft_plan_members ?? [];
    const activeGroup = groups.findIndex(group => group.some(key => activeMembers.includes(key)));
    if (activeGroup < 0 && activeMembers.length > 1) {
      groups.push(activeMembers);
    }
    const visibleRecords = records.filter(({kind,p,state}) => state?.state === 'saved' &&
      !(kind === 'operation' && ['run_atc','run_unit_tests'].includes(p.tool)));
    const key = JSON.stringify([selectedTask.id, selectedTask.title, visibleRecords, groups, [...creations.values()]]);
    if (key === changeHistoryKey) return;
    changeHistoryKey = key;
    $('#agent-change-history-session').textContent = selectedTask.title ?? '当前会话';
    $('#agent-change-history-empty').hidden = visibleRecords.length > 0 || creations.size > 0;
    const list = $('#agent-change-history-list');
    const expanded = new Set([...list.querySelectorAll('details[open]')].map(node => node.dataset.planKey));
    list.replaceChildren();
    const sections = [];
    function creationRow(receipt) {
      const row = element('li',undefined,'change-history-record change-history-receipt');
      const description = element('span',undefined,'change-history-description');
      const name = receipt.object_uri.split('/').filter(Boolean).at(-1);
      description.append(element('strong','创建程序 · ' + name),
        element('small',new Date(receipt.completed_at).toLocaleString('zh-CN')));
      row.append(description,element('span','已创建','badge neutral'));
      return row;
    }
    function recordRow({kind,p,title,state}) {
      const row = element('li');
      const button = element('button', undefined, 'change-history-record');
      button.type = 'button';
      const description = element('span', undefined, 'change-history-description');
      description.append(element('strong', title));
      const date = new Date(p.created_at);
      const object = p.object_label ?? (p.object_uri ?? state?.saved_source?.object_uri)?.split('/').filter(Boolean).at(-1);
      description.append(element('small', [object, Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN')].filter(Boolean).join(' · ')));
      button.append(description, element('span', draftLabel(state), 'badge neutral'));
      button.onclick = () => void openDraft(kind, p.id);
      row.append(button);
      return row;
    }
    const groupedKeys = new Set(groups.flat());
    for (const members of groups) {
      const items = visibleRecords.filter(record => members.includes(recordKey(record)));
      const receipts = [...creations.values()].filter(receipt => members.includes(receipt.draft_key));
      if (!items.length && !receipts.length) continue;
      const counts = new Map();
      for (const {state} of items) {
        const label = draftLabel(state);
        counts.set(label,(counts.get(label) ?? 0) + 1);
      }
      if (receipts.length) counts.set('已创建',receipts.length);
      const row = element('li');
      const card = element('details',undefined,'agent-draft-card change-history-plan');
      card.dataset.planKey = selectedTask.id + ':' + members[0];
      card.open = expanded.has(card.dataset.planKey);
      const heading = element('summary',undefined,'change-history-plan-heading');
      const description = element('span',undefined,'change-history-description');
      description.append(element('strong', '修改计划 · ' + new Set([
        ...items.map(recordKey), ...receipts.map(receipt => receipt.draft_key)
      ]).size + ' 项'), element('small',[...counts].map(([label,count]) => label + ' ' + count + ' 项').join(' · ')));
      const objects = [...new Set([...items.map(({p,state}) => draftObject(p) ?? draftObject(state?.saved_source ?? {})),
        ...receipts.map(receipt => draftObject(receipt))].filter(Boolean))];
      if (objects.length) description.append(element('small',objects.join(' · ')));
      heading.append(description);
      const children = element('ul',undefined,'change-history-list');
      children.append(...items.map(recordRow), ...receipts.map(creationRow));
      card.append(heading,children);
      row.append(card);
      const date = [...items.map(({p,state}) => state?.updated_at ?? p.created_at),
        ...receipts.map(receipt => receipt.completed_at)].sort().at(-1);
      sections.push({row,date});
    }
    for (const record of visibleRecords.filter(record => !groupedKeys.has(recordKey(record)))) {
      sections.push({row:recordRow(record),date:record.state?.updated_at ?? record.p.created_at});
    }
    for (const receipt of creations.values()) {
      if (!groupedKeys.has(receipt.draft_key)) sections.push({row:creationRow(receipt),date:receipt.completed_at});
    }
    list.append(...sections.sort((a,b) => b.date.localeCompare(a.date)).map(section => section.row));
  }
  $('#agent-change-history').onclick = () => {
    if (!selectedTask || sessionDetailLoading || sessionLoadFailed) return;
    changeHistoryTaskId = selectedTask.id;
    const taskId = changeHistoryTaskId;
    historicalCreations = [];
    changeHistoryKey = undefined;
    $('#agent-change-history-dialog').showModal();
    renderChanges();
    void api(`agent/tasks/${taskId}/draft-creation-history`).then(records => {
      if (taskId !== selectedTask?.id || !$('#agent-change-history-dialog').open) return;
      historicalCreations = records;
      renderChanges();
    }).catch(error => { if (taskId === selectedTask?.id) toast(error.message,true); });
  };
  $('#agent-change-history-close').onclick = () => {
    draftRequest++;
    $('#agent-change-history-dialog').close();
  };
  $('#agent-change-history-dialog').addEventListener('cancel', () => { draftRequest++; });
  function draftPath(v=draftView) { return `agent/tasks/${v.taskId}/drafts/${v.kind}/${v.id}`; }
  function renderDraftState() {
    const state = draftView?.detail.draft;
    const readOnly = ['saved', 'discarded', 'superseded'].includes(state?.state);
    $('#agent-draft-heading').textContent = readOnly ? '查看修改' : '审核修改';
    $('#agent-draft-note').textContent = readOnly ? draftLabel(state)
      : draftView.kind === 'operation' ? '保存将执行上述操作。' : '保存到 SAP 非活动版本，成功后再选择是否激活。';
    $('#agent-draft-status').textContent = state?.state === 'saved' && state.legacy && state.message?.includes('继续修改')
      ? state.message.split('；')[0] + '。'
      : draftView.detail.notice ?? state?.message ?? (state?.state === 'saving' ? '正在保存…' : '');
    draftControls();
  }
  function confirmSourceResult(taskId,kind,id,artifactId) {
    if (draftWorking || modelStatus?.active_task_id) return;
    confirmAction('核实保存结果','请先在 SAP 中确认上次操作已结束，编辑锁已释放。确认后会读取非活动源码。只有源码与草稿一致时才会登记保存成功。',async()=>{
      if (selectedTask?.id !== taskId || draftWorking) return;
      draftWorking = true;
      updateControls();
      try {
        const state = await api(`agent/tasks/${taskId}/drafts/${kind}/${id}/reconcile`,'POST',
          {artifact_id:artifactId,sap_execution_finished:true});
        if (selectedTask?.id !== taskId) return;
        if ($('#agent-draft-plan-dialog').open && planView?.taskId === taskId) {
          planView.plan = await api(`agent/tasks/${taskId}/draft-plan`);
          $('#agent-draft-plan-status').textContent = state.message;
          renderDraftPlan();
        } else if (draftView?.taskId === taskId && draftView.id === id) {
          draftView.detail = {...draftView.detail,draft:state,can_save:false,can_discard:false,can_reconcile:false};
          renderDraftState();
        }
        toast(state.message);
        await poll();
      } catch (error) { toast(error.message,true); }
      finally { draftWorking = false; updateControls(); }
    },false);
  }
  $('#agent-draft-reconcile').onclick = () => {
    if (draftView) confirmSourceResult(draftView.taskId,draftView.kind,draftView.id,draftView.detail.proposal.artifact_id);
  };
  function draftControls() {
    const readOnly = ['saved', 'discarded', 'superseded'].includes(draftView?.detail.draft?.state);
    $('#agent-draft-dialog .dialog-actions').hidden = readOnly;
    $('#agent-draft-reconcile').hidden = readOnly || !draftView?.detail.can_reconcile;
    $('#agent-draft-reconcile').disabled = draftWorking || Boolean(modelStatus?.active_task_id);
    $('#agent-draft-save').disabled=draftWorking||!draftView?.detail.can_save||Boolean(modelStatus?.active_task_id)||!connections.find(c=>c.connection_id===selectedTask?.connection_id)?.write_enabled;
    $('#agent-draft-discard').disabled=draftWorking||Boolean(modelStatus?.active_task_id)||!draftView?.detail.can_discard;
    $('#agent-draft-close').disabled=draftWorking;
  }
  async function openDraft(kind,id,activate=false,inline=false) {
    const taskId=selectedTask?.id,request=++draftRequest;
    if(!taskId)return;
    try {
      const detail=await api(`agent/tasks/${taskId}/drafts/${kind}/${id}`);
      if(request!==draftRequest||selectedTask?.id!==taskId)return;
      if(detail.draft)selectedTask.drafts=[...(selectedTask.drafts??[]).filter(d=>d.key!==detail.draft.key),detail.draft];
      draftView={taskId,kind,id,detail};
      const p=detail.proposal;
      const creation = creationSummary(p);
      $('#agent-draft-target').textContent=connectionLabel(connections.find(c=>c.connection_id===selectedTask.connection_id)??{name:'当前系统',client:selectedTask.client});
      $('#agent-draft-summary').textContent=creation?.title ?? (kind==='change'?p.summary:kind==='workflow'?p.plan.object_uri:(operationNames[p.tool]??p.tool));
      $('#agent-draft-creation').replaceChildren(...(creation ? [creationFields(creation)] : []));
      const content=kind==='change'?p.proposed_source:kind==='workflow'?p.plan.source:p.tool==='create_ddic_object'?p.intent.input.source:creation?'':JSON.stringify(p.intent.input,null,2);
      $('#agent-draft-source').textContent=content;
      const plan=p.plan??p;
      $('#agent-draft-plan').textContent=kind==='operation'||creation?'':[
        plan.object_uri?'对象：'+plan.object_uri:plan.name?'程序：'+plan.name:'',
        plan.package_name?'开发包：'+plan.package_name:'',
        plan.description?'说明：'+plan.description:'',
        plan.transport_task?'传输任务：'+plan.transport_task:''
      ].filter(Boolean).join('\n');
      const showSource = !creation || Boolean(p.plan?.source?.trim()) || p.tool==='create_ddic_object';
      const diff=showSource ? reviewDiff(p,detail.diff) : undefined;
      $('#agent-draft-diff').hidden=!diff;
      $('#agent-draft-diff').replaceChildren(...(diff ? [draftDiff(diff,creation ? '新增源码' : '代码差异')] : []));
      $('#agent-draft-source').parentElement.open = !diff || diff.truncated;
      $('#agent-draft-source').parentElement.hidden = !showSource;
      renderDraftState();
      if (activate && detail.draft?.state === 'saved' && detail.draft.saved_source && !detail.draft.activation) showActivation();
      else if (!inline) $('#agent-draft-dialog').showModal();
      return true;
    } catch(error){toast(error.message,true);}
  }
  function showActivation() {
    $('#agent-draft-dialog').close(); $('#agent-activate-atc').checked=false;
    const ddic=isDdicUri(draftView?.detail.draft?.saved_source?.object_uri);
    $('#agent-activate-status').textContent=ddic?'字典对象已保存，是否现在激活？':'源码已保存，是否现在激活？';
    $('#agent-activate-now').disabled=false; $('#agent-activate-later').disabled=false;
    $('#agent-activate-later').textContent='稍后激活';
    $('#agent-activate-atc').closest('label').hidden=ddic;
    $('#agent-activate-atc').disabled=ddic;
    $('#agent-activate-dialog').showModal();
  }
  async function draftAction(action) {
    if(!draftView||draftWorking||['saved','discarded','superseded'].includes(draftView.detail.draft?.state))return;
    const v=draftView; draftWorking=true; draftControls();
    $('#agent-draft-status').textContent=action==='save'?'正在核对源码基线并保存…':'正在处理…';
    if (action==='save') openDraftSave(v.taskId,[{key:`${v.kind}:${v.id}`,proposal:v.detail.proposal,
      label:$('#agent-draft-summary').textContent,state:'pending'}],v);
    try {
      const state=await api(draftPath(v)+'/'+action,'POST',{
        confirm:true,artifact_id:v.detail.proposal.artifact_id,...(action==='save'?{manual_recovery:true}:{})
      });
      if (action==='save') {
        saveView.items[0].state = state.state;
        saveView.state = state.state==='saved' ? 'saved' : 'failed';
        saveView.message = state.message;
        saveView.regenerateId = state.regenerate_id;
        if (state.state!=='saved') saveView.failure = state;
        renderDraftSave();
      }
      if(v!==draftView)return;
      v.detail.draft=state;v.detail.can_save=false;v.detail.can_discard=false;
      if (action === 'save' && ['failed','uncertain'].includes(state.state)) {
        v.detail = await api(draftPath(v));
        if (v !== draftView) return;
      }
      selectedTask.drafts = [...(selectedTask.drafts ?? []).filter(draft => draft.key !== state.key), state];
      renderChanges();
      renderDraftState();
      if(action==='discard') $('#agent-draft-dialog').close();
      if(action==='save'&&state.state==='saved'&&state.saved_source){saveDialog.close();showActivation();}
      await poll();
    } catch(error){
      if (action==='save' && saveView?.state==='running') {
        saveView.state = 'unknown'; saveView.failure = {message:error.message}; renderDraftSave();
      } else if(v===draftView) {
        if ($('#agent-draft-dialog').open) $('#agent-draft-status').textContent=error.message;
        else toast(error.message,true);
      }
    }
    finally {draftWorking=false;draftControls();updateCardControls();updateDraftSaveControls();}
  }
  $('#agent-draft-save').onclick=()=>void draftAction('save');
  $('#agent-draft-discard').onclick=()=>void draftAction('discard');
  $('#agent-draft-close').onclick=()=>$('#agent-draft-dialog').close();
  $('#agent-draft-dialog').addEventListener('cancel',e=>{if(draftWorking)e.preventDefault();});
  $('#agent-activate-dialog').addEventListener('cancel',e=>{if(draftWorking)e.preventDefault();});
  $('#agent-activate-later').onclick=()=>$('#agent-activate-dialog').close();
  $('#agent-activate-now').onclick=async()=>{
    if(!draftView||draftWorking)return;
    const v=draftView;draftWorking=true;
    $('#agent-activate-now').disabled=true;$('#agent-activate-later').disabled=true;
    $('#agent-activate-atc').disabled=true;
    $('#agent-activate-status').textContent='正在检查并激活…';
    try{
      const state=await api(draftPath(v)+'/activate','POST',{confirm:true,artifact_id:v.detail.proposal.artifact_id,atc:$('#agent-activate-atc').checked});
      if(v!==draftView)return;
      v.detail.draft=state;$('#agent-activate-status').textContent=state.message;
      await poll();
    }catch(error){if(v===draftView){$('#agent-activate-status').textContent=error.message;$('#agent-activate-now').disabled=false;$('#agent-activate-atc').disabled=isDdicUri(v.detail.draft?.saved_source?.object_uri);}}
    finally{draftWorking=false;$('#agent-activate-later').disabled=false;$('#agent-activate-later').textContent='关闭';}
  };
  function updateControls() {
    updateCardControls();
    updateLocalScriptControls();
    if(draftView)draftControls();
    const active = Boolean(modelStatus?.active_task_id);
    const activeHere = selectedTask && (!terminal(selectedTask) || modelStatus?.active_task_ids?.includes(selectedTask.id));
    const steering = selectedTask && !terminal(selectedTask);
    const waiting = selectedTask?.status === 'waiting_input';
    const unavailable = sessionLoading || sessionLoadFailed;
    const send = $('#agent-send');
    const hasText = Boolean($('#agent-prompt').value.trim());
    const hasPrompt = hasText || pendingWebsites.length>0;
    const resumable = ['stopped', 'interrupted'].includes(selectedTask?.status) ||
      (selectedTask?.status === 'failed' && (['AGENT_BUDGET_LIMIT', 'AGENT_CONTEXT_LIMIT', 'AGENT_COMPACTION_FAILED',
        'MODEL_TIMEOUT', 'MODEL_CONNECTION_FAILED'].includes(selectedTask.error?.code) ||
        (selectedTask.error?.code === 'AGENT_SAP_FAILED' && selectedTask.write_mode !== 'unrestricted')));
    const tableBlocked = resumable && selectedTask.allow_table_data && !connections.find(c=>c.connection_id===selectedTask.connection_id)?.allow_table_data;
    const resume = resumable && !hasPrompt;
    const action = resume ? 'resume' : 'send';
    if (send.dataset.action!==action) {
      send.dataset.action = action;
      send.replaceChildren(icon(resume?'play':'arrow-up'));
      window.lucide?.createIcons({root:send});
      $('#agent-keyboard-hint').textContent = resume ? '回车继续任务，输入文字后回车发送。' : '回车发送，Shift 加回车换行。';
    }
    send.formNoValidate = resume || (!hasText && pendingWebsites.length>0);
    send.disabled = busy || unavailable || waiting || !modelStatus?.configured || Boolean(activeHere&&!steering) ||
      (steering ? !hasText : resume ? tableBlocked : !hasPrompt || !connections.some(c=>c.connection_id===$('#agent-connection').value));
    send.title = steering ? '发送补充说明' : resume ? '继续任务' : selectedTask ? '发送' : '开始分析';
    send.setAttribute('aria-label',send.title);
    $('#agent-prompt').placeholder = waiting ? '请回答上方的问题' : steering ? '补充要求或调整方向…' : selectedTask ? '继续追问…' : '输入你的问题…';
    const missingConnection = !busy && modelStatus?.configured && !active && connections.length > 0 && !$('#agent-connection').value;
    $('#agent-send-hint').textContent = busy || sessionLoading ? '正在处理，请稍候。'
      : sessionLoadFailed ? '会话加载失败，请重新连接。'
      : waiting ? '请回答或跳过上方的问题。'
      : steering ? '发送补充说明可调整当前任务。'
        : !modelStatus?.configured ? '请先在模型设置中配置 API Key。'
          : !connections.length ? '请先添加 SAP 连接。'
            : missingConnection ? '选择一个 SAP 系统后即可开始分析。' : '';
    $('#agent-settings').disabled = busy || active;
    $('#agent-configure-model').disabled = busy || active;
    $('#agent-new').disabled = busy;
    $('#agent-history').disabled = busy;
    $('#agent-connections').disabled = busy;
    const connectionSelect = $('#agent-connection'), connectionPicker = $('#agent-connection-picker');
    const connectionName = connectionSelect.selectedOptions[0]?.text ?? '暂无 SAP 系统';
    const connectionLabelNode = connectionPicker.querySelector('span');
    if (connectionLabelNode.textContent !== connectionName) connectionLabelNode.textContent = connectionName;
    connectionSelect.disabled = connectionPicker.disabled = busy || active || !connections.length;
    connectionPicker.title = active ? '当前连接还有任务正在运行' : connectionName;
    connectionPicker.setAttribute('aria-label','切换 SAP 系统，当前为 '+connectionName);
    if (connectionPicker.disabled && $('#agent-connection-menu').matches(':popover-open')) $('#agent-connection-menu').hidePopover();
    for (const option of document.querySelectorAll('#agent-model-menu button[data-value], #agent-tuning-menu button[data-value]')) option.disabled = busy || active;
    $('#agent-write-mode').disabled = busy || active || unavailable;
    $('#agent-prompt').disabled = busy || unavailable || waiting || Boolean(activeHere&&!steering);
    $('#agent-upload').disabled = busy || unavailable || waiting || Boolean(activeHere);
    for (const button of $('#agent-upload-list').querySelectorAll('button')) button.disabled = busy || unavailable || waiting || Boolean(activeHere);
    $('#agent-cleanup').disabled = busy || !$('#agent-connection').value;
    $('#agent-compact').disabled = busy || unavailable || active || !modelStatus?.configured || selectedTask?.status !== 'completed';
    for(const row of document.querySelectorAll('#agent-session-list .session-item')){
      const task=taskList.find(task=>task.id===row.dataset.taskId);
      for(const button of row.querySelectorAll('button'))button.disabled=busy||button.closest('.session-row-actions')&&(unavailable||!terminal(task));
    }
    $('#agent-report-history').disabled=busy||unavailable||reportLoading;
    $('#agent-report-switcher').disabled=busy||unavailable||reportLoading||!$('#agent-report-history').querySelector('option:not([disabled])');
    for(const button of document.querySelectorAll('.report-row-actions button'))button.disabled=busy||unavailable||reportLoading||!terminal(selectedTask);
    $('#agent-report-export').disabled=busy||unavailable||!selectedTask||reportTaskId!==selectedTask.id||!reportValue||!!(selectedTask?.output_mode==='report'&&!terminal(selectedTask));
    $('#agent-stop').hidden = !selectedTask || terminal(selectedTask);
    $('#agent-send').hidden = !$('#agent-stop').hidden && !hasText;
    $('#agent-stop').disabled = busy || unavailable;
    $('#agent-table-policy-note').hidden = !tableBlocked;
    $('#agent-table-policy-note').textContent = tableBlocked
      ? '本任务原先允许访问表数据，当前连接的权限已关闭。请新建代码分析任务，或开启后继续。' : '';
  }
  function activityDuration(seconds){const n=Math.max(0,Math.round(seconds));return n<1?'不到1秒':n<60?n+'秒':Math.floor(n/60)+'分'+(n%60?n%60+'秒':'');}
  const activityResults = new Map();
  function inlineToolResult(taskId, sequence) {
    if(activityResults.has(sequence))return activityResults.get(sequence);
    const node=element('div',undefined,'activity-result');
    const status=element('div','正在读取工具结果…','activity-result-status');
    status.setAttribute('role','status');
    const output=element('pre',undefined,'activity-result-text');
    output.tabIndex=0;
    output.hidden=true;
    node.append(status,output);
    let offset=0,loading=false;
    async function load(){
      if(loading||offset===null)return;
      loading=true;
      status.textContent='正在读取工具结果…';
      try{
        const page=await api(`agent/tasks/${taskId}/tool-results/${sequence}?offset=${offset}`);
        output.append(document.createTextNode(page.text));
        output.hidden=!page.total_characters;
        offset=page.next_offset;
        status.textContent=page.total_characters?'工具结果':'结果为空';
      }catch(error){status.textContent=error.message;}
      finally{loading=false;}
    }
    output.addEventListener('scroll',()=>{
      if(output.scrollHeight-output.scrollTop-output.clientHeight<=32)void load();
    });
    const result={node,show:()=>{if(offset===0)void load();}};
    activityResults.set(sequence,result);
    return result;
  }
  function renderActivity() {
    const task=selectedTask,progress=$('#agent-progress'),history=$('#agent-activity-history');
    progress.hidden=!task||!(task.events?.length||task.events_archived||streamNotice);
    if(progress.hidden){history.open=false;activityKey=undefined;activityTurn=undefined;activityWasActive=false;activityResults.clear();return;}
    const activity=window.SapLinkActivity.build(task),turn=task.id+':'+(task.current_user_id??activity.turn);
    const changedTurn=activityTurn!==turn;
    if(changedTurn){activityTurn=turn;history.open=activity.active;activityKey=undefined;activityResults.clear();}
    else if(activityWasActive!==activity.active)history.open=activity.active;
    activityWasActive=activity.active;
    const labels={context:'整理工作记忆',answer:'生成回答',model:'思考'};
    const notice=activity.active?streamNotice:'';
    const label=activity.active?(notice||(activity.current==='queued'?'等待执行':'正在'+(labels[activity.current]??toolNames[activity.current]??'读取 SAP 对象'))):task.status==='completed'?'分析完成':names[task.status];
    if($('#agent-activity-current').textContent!==label)$('#agent-activity-current').textContent=label;
    $('#agent-activity-current').hidden=task.status==='completed';
    $('#agent-activity-time').textContent='用时 '+activityDuration(activity.elapsed);
    $('#agent-activity-time').title='本轮经过时间，包含暂停和等待';
    const indicator=$('#agent-activity-indicator');indicator.className='activity-indicator '+(activity.active?'is-running':task.status==='completed'?'is-completed':task.status==='failed'?'is-failed':'is-stopped');
    indicator.textContent=activity.active?'':task.status==='completed'?'✓':task.status==='failed'?'!':'▪';
    indicator.hidden=task.status==='completed';
    history.hidden=!activity.groups.length&&!notice;
    $('#agent-activity-summary').textContent=(activity.partial?'近期 ':'')+'思考与执行'+(activity.operations?' · '+activity.operations+' 项操作':'');
    $('#agent-activity-archive').hidden=!activity.partial;
    const key=turn+':'+task.status+':'+task.events?.at(-1)?.sequence;
    if(key===activityKey)return;activityKey=key;
    const list=$('#agent-events'),open=new Set(changedTurn?[]:[...list.querySelectorAll('details[open]')].map(node=>node.dataset.key));list.replaceChildren();
    for(const group of activity.groups){
      if(group.tool==='model'){
        for(const entry of group.rows){
          if(entry.summary)list.append(element('li',entry.summary,'activity-summary'));
        }
        continue;
      }
      const row=element('li'),detail=element('details',undefined,'activity-tool');detail.dataset.key=String(group.key);detail.open=open.has(String(group.key));
      const summary=element('summary'),mark=element('span',group.status==='running'?'':group.status==='completed'?'✓':group.status==='failed'?'!':'▪','activity-indicator is-'+group.status);
      const label=element('span',(labels[group.tool]??toolNames[group.tool]??'读取 SAP 对象')+(group.rows.length>1?' × '+group.rows.length:''),'activity-tool-label');
      summary.append(mark,label,icon('chevron-down'));detail.append(summary);
      const body=element('div',undefined,'activity-tool-detail');
      body.append(element('code',group.tool==='context'?'自动整理上下文':group.tool));
      const results=[];
      for(const entry of group.rows){
        const line=element('div',undefined,'activity-receipt'),status=entry.status==='completed'?'完成':entry.status==='failed'?'失败':entry.status==='running'?'执行中':'已中断';
        const duration=entry.end&&!entry.incomplete?activityDuration(Math.max(0,(Date.parse(entry.end)-Date.parse(entry.start))/1000)):'';
        const text=element('span',status+(duration?' · '+duration:''));text.title=new Date(entry.start).toLocaleString();line.append(text);
        if(entry.operation)line.append(element('code',entry.operation));
        body.append(line);
        if(entry.result){
          const result=inlineToolResult(task.id,entry.result);
          body.append(result.node);results.push(result);
        }
      }
      detail.append(body);row.append(detail);list.append(row);
      if(results.length){
        const show=()=>{if(detail.open)for(const result of results)result.show();};
        detail.addEventListener('toggle',show);show();
      }
    }
    if(!list.children.length&&activity.groups.length)list.append(element('li',
      activity.active?'正在整理本轮回复。':task.status==='completed'?'已直接生成回复。':'本轮思考已结束。','activity-summary'));
    icons();
  }
  const localScriptDialog = $('#agent-local-script-dialog');
  const localStates = {pending:'待确认',running:'运行中',completed:'已完成',failed:'运行失败',interrupted:'结果待核实'};
  function updateLocalScriptControls() {
    const run = $('#agent-local-script-run');
    run.hidden = localScriptView?.detail.record.state!=='pending';
    run.disabled = busy || localScriptWorking || !terminal(selectedTask) || Boolean(modelStatus?.active_task_id);
    $('#agent-local-script-close').disabled = localScriptWorking;
  }
  function renderLocalScript() {
    const {record,input,result} = localScriptView.detail;
    $('#agent-local-script-heading').textContent = input.title;
    $('#agent-local-script-runtime').textContent = input.runtime==='node'?'Node.js · JavaScript':'Windows PowerShell';
    $('#agent-local-script-source').textContent = input.script;
    const files = $('#agent-local-script-files');
    files.hidden = !input.outputs.length;
    files.textContent = '预计生成：'+input.outputs.join('、');
    $('#agent-local-script-status').textContent = record.message ?? localStates[record.state];
    const output = $('#agent-local-script-output');
    const lines = [result?.stdout,result?.stderr].filter(Boolean);
    output.hidden = !lines.length; output.textContent = lines.join('\n');
    updateLocalScriptControls();
  }
  async function openLocalScript(taskId,id) {
    try {
      const path = `agent/tasks/${taskId}/local-scripts/${id}`;
      const detail = await api(path);
      if (selectedTask?.id!==taskId || localScriptDialog.open) return;
      localScriptView = {taskId,path,detail};
      renderLocalScript(); localScriptDialog.showModal();
    } catch (error) { toast(error.message,true); }
  }
  $('#agent-local-script-close').onclick = () => { if (!localScriptWorking) localScriptDialog.close(); };
  localScriptDialog.addEventListener('cancel',event=>{if (localScriptWorking) event.preventDefault();});
  localScriptDialog.addEventListener('close',()=>{localScriptView=undefined;});
  $('#agent-local-script-run').onclick = async () => {
    const current = localScriptView;
    if (!current || $('#agent-local-script-run').disabled) return;
    localScriptWorking = true; busy = true; generation++; updateControls();
    $('#agent-local-script-status').textContent = '正在运行脚本…';
    try {
      current.detail = await api(current.path+'/run','POST',{confirm:true,artifact_id:current.detail.record.artifact_id});
      if (localScriptView===current) renderLocalScript();
    } catch (error) { $('#agent-local-script-status').textContent = error.message; }
    finally {
      localScriptWorking = false; busy = false; updateControls();
      await poll(); schedule();
    }
  };
  async function downloadLocalFile(taskId,file) {
    try {
      const response = await fetch(`/api/agent/tasks/${taskId}/generated-files/${file.artifact_id}`,{headers:{'X-Admin-Token':adminKey??''}});
      if (!response.ok) throw new Error('无法下载此文件。');
      const url = URL.createObjectURL(await response.blob());
      const link = element('a');
      link.href=url; link.download=file.name; link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch (error) { toast(error.message,true); }
  }
  let mcpChangeBusy = false;
  async function applyMcpChange(taskId,id,confirm) {
    if (mcpChangeBusy || busy) return;
    mcpChangeBusy = true;
    renderLocalWork();
    try {
      const updated = await api(`agent/tasks/${taskId}/mcp-change/${id}`,'POST',{confirm});
      if (selectedTask?.id===taskId) selectedTask = {...selectedTask,mcp_proposal:updated.mcp_proposal};
      if (confirm) toast('MCP 变更已完成');
    } catch (error) {
      toast(error.message,true);
    } finally {
      mcpChangeBusy = false;
      renderLocalWork();
      await poll();
      schedule();
    }
  }
  function renderLocalWork() {
    const node = $('#agent-local-work'), task = selectedTask;
    const scripts = task?.local_scripts ?? [], files = task?.generated_files ?? [];
    const proposal = task?.mcp_proposal;
    const key = JSON.stringify([task?.id,scripts,files,proposal,terminal(task),mcpChangeBusy]);
    if (key===localWorkKey) return;
    localWorkKey = key;
    node.hidden = !scripts.length && !files.length && !proposal;
    node.replaceChildren();
    if (proposal) {
      const card = element('div',undefined,'agent-mcp-change');
      const heading = element('div',undefined,'agent-mcp-change-heading');
      heading.append(icon('server'),element('strong','MCP 变更'));
      const status = {pending:'待确认',submitted:'已提交，结果待核实',completed:'已完成',cancelled:'已取消'};
      heading.append(element('span',mcpChangeBusy?'正在处理…':status[proposal.state],'muted'));
      card.append(heading,element('p',proposal.label));
      if (proposal.state==='pending' && terminal(task)) {
        const actions = element('div',undefined,'agent-mcp-change-actions');
        for (const [label,confirm] of [['取消',false],['确认变更',true]]) {
          const button = element('button',label,confirm?'primary':undefined);
          button.type = 'button';
          button.disabled = mcpChangeBusy;
          button.onclick = () => void applyMcpChange(task.id,proposal.id,confirm);
          actions.append(button);
        }
        card.append(actions);
      }
      node.append(card);
    }
    for (const script of scripts) {
      const row = element('button',undefined,'agent-local-work-item');
      row.type='button';
      row.append(icon('terminal'),element('strong',script.title),element('span',localStates[script.state]));
      row.onclick = () => void openLocalScript(task.id,script.id);
      node.append(row);
    }
    for (const file of files) {
      const row = element('button',undefined,'agent-local-work-item');
      row.type='button';
      row.title='下载 '+file.name;
      row.setAttribute('aria-label',row.title);
      row.append(icon('file-text'),element('strong',file.name),icon('download'));
      row.onclick = () => void downloadLocalFile(task.id,file);
      node.append(row);
    }
    if (!node.hidden) icons();
  }
  function renderTask() {
    $('#agent-empty').hidden = Boolean(selectedTask);
    renderChanges();
    renderLocalWork();
    renderActivity();
    $('#agent-result').hidden = !selectedTask;
    $('#agent-task-status').textContent = sessionDetailLoading ? '加载中' : sessionLoadFailed ? '加载失败' : selectedTask ? names[selectedTask.status] || '未知状态' : '等待提问';
    $('#agent-task-error').hidden = !selectedTask?.error || Boolean(selectedTask?.answer);
    $('#agent-task-error').textContent = selectedTask?.error?.message ?? '';
    const target = selectedTask ? connections.find(c => c.connection_id === selectedTask.connection_id)
      : connections.find(c => c.connection_id === $('#agent-connection').value);
    $('#agent-target').textContent = selectedTask
      ? `任务目标：${target?.name || '原连接已移除'} · Client ${selectedTask.client}`
      : target ? connectionLabel(target) : '请先配置并选择系统。';
    if (selectedTask) {
      $('#agent-question').textContent = sessionDetailLoading ? '正在加载对话…' : sessionLoadFailed ? '对话加载失败，请重新连接。' : selectedTask.current_prompt ?? selectedTask.prompt;
      $('#agent-question-attachments').textContent = sessionDetailLoading || sessionLoadFailed ? '' : messageResources(selectedTask.current_attachments,selectedTask.current_references);
      const draft = !terminal(selectedTask) && !selectedTask.live?.finished ? selectedTask.live?.text : '';
      const reply = sessionDetailLoading || sessionLoadFailed ? '' : selectedTask.answer || draft || '';
      renderCurrentReply(reply, Boolean(draft && !selectedTask.answer));
    }
    renderChatHistory();
    renderQuestionCard();
    renderReport();
    updateControls();
    ensureStreaming();
  }
  function streamStatus(message) {
    if(streamNotice===message)return;
    streamNotice=message;
    renderActivity();
  }
  function stopStreaming() {
    streamSession?.controller.abort();
    streamSession = undefined;
    displayedDraft = undefined;
    streamStatus('');
  }
  function pauseStreaming() {
    if(!streamSession?.http)stopStreaming();
  }
  function renderCurrentReply(text, streaming) {
    $('#agent-current-reply').hidden = !text.trim();
    $('#agent-stream-note').hidden = !streaming || !text.trim();
    renderAnswer(text);
  }
  function drawDraft(snapshot) {
    if (!selectedTask || terminal(selectedTask)) return;
    if (snapshot.finished) { void poll(); return; }
    selectedTask.live = snapshot;
    if(!snapshot.finished && snapshot.round>0 && selectedTask.status==='queued'){
      selectedTask.status='running';$('#agent-task-status').textContent=names.running;
    }
    const marker = `${snapshot.run_id}:${snapshot.round}:${snapshot.revision}`;
    if (marker === displayedDraft) return; displayedDraft = marker;
    renderCurrentReply(snapshot.text || '', true);
    renderReport();renderActivity();
  }
  function streamRetryDelay(signal, milliseconds) {
    return new Promise(resolve => {
      if(signal.aborted){resolve();return;}
      const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};
      const timer=setTimeout(finish,milliseconds);
      signal.addEventListener('abort',finish,{once:true});
    });
  }
  async function readDraftStream(session, id) {
    const attempt = new AbortController();
    const signal = AbortSignal.any([session.controller.signal, attempt.signal]);
    let reader, timeout;
    const arm = delay => {
      clearTimeout(timeout);
      timeout=setTimeout(()=>attempt.abort(),delay);
    };
    arm(10000);
    try {
      const response = await fetch(`/api/agent/tasks/${id}/stream`,{headers:{'X-Admin-Token':adminKey??''},signal});
      if(!response.ok||!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))
        throw new Error('实时连接暂不可用');
      reader=response.body.getReader();
      const decoder=new TextDecoder();
      let buffer='';
      arm(30000);
      for (;;) {
        const part=await reader.read();
        if(part.done)break;
        arm(30000);
        buffer+=decoder.decode(part.value,{stream:true});
        let boundary;
        while((boundary=/\r?\n\r?\n/.exec(buffer))){
          const frame=buffer.slice(0,boundary.index);
          buffer=buffer.slice(boundary.index+boundary[0].length);
          if(streamSession!==session||signal.aborted)return true;
          const data=frame.split(/\r?\n/).find(line=>line.startsWith('data:'));
          if(!data)continue;
          const snapshot=JSON.parse(data.slice(5));
          if(snapshot?.task_id!==id||typeof snapshot.text!=='string'||typeof snapshot.finished!=='boolean'||
              !Number.isSafeInteger(snapshot.revision))throw new Error('实时快照无效');
          streamStatus('');
          drawDraft(snapshot);
          if(snapshot.finished)return true;
        }
      }
      return false;
    } finally {
      clearTimeout(timeout);
      attempt.abort();
      await reader?.cancel().catch(()=>{});
    }
  }
  async function connectDraftStream(session,id) {
    const {signal}=session.controller;
    for(let retry=0;retry<=5;retry++){
      if(retry){
        streamStatus(`正在重连：${retry} / 5`);
        await streamRetryDelay(signal,Math.min(retry*400,1600));
      }
      if(signal.aborted||streamSession!==session)return;
      try { if(await readDraftStream(session,id))return; }
      catch { /* Retry a disconnected stream without starting a new task. */ }
      if(signal.aborted||streamSession!==session)return;
    }
    session.http=true;
    streamStatus('已切换为 HTTP 输出');
    void poll();
  }
  function ensureStreaming() {
    if(!selectedTask||sessionDetailLoading||sessionLoadFailed||terminal(selectedTask)){
      if(streamSession)stopStreaming();
      return;
    }
    if(view.hidden||document.hidden){pauseStreaming();return;}
    const id=selectedTask.id,key=id+':'+(selectedTask.current_user_id??'');
    if(streamSession?.key===key)return;
    stopStreaming();
    streamSession={key,controller:new AbortController(),http:false};
    void connectDraftStream(streamSession,id);
  }
  function renderChatHistory() {
    const node = $('#agent-chat-history'); node.replaceChildren();
    const turn = $('#agent-turn-history'); turn.replaceChildren();
    const messages = chatTaskId === selectedTask?.id ? chatMessages : [];
    const current = messages.findIndex(message => message.id === selectedTask?.current_user_id);
    for (const [index,message] of messages.entries()) {
      if(index===current || message.id===selectedTask?.current_answer_id)continue;
      const row = element('div', '', `agent-message ${message.role === 'user' ? 'user' : 'assistant'}`);
      row.append(element('span', message.role === 'user' ? '你的问题' : 'SapLink'));
      const text = element('div');
      if (message.role === 'assistant') renderAnswer(message.content,text); else text.textContent = message.content;
      row.append(text);
      if (message.attachments?.length || message.references?.length)
        row.append(element('div',messageResources(message.attachments,message.references),'agent-sent-attachments'));
      (current >= 0 && index > current ? turn : node).append(row);
    }
  }
  let questionView;
  function renderQuestionCard(force = false) {
    const node = $('#agent-question-card'), pending = selectedTask?.pending_question;
    node.hidden = !pending;
    if (!pending) {
      if(questionView)node.replaceChildren();
      questionView = undefined;
      return;
    }
    if (questionView?.id !== pending.id) {
      questionView = {id:pending.id,index:0,answers:Array(pending.questions.length).fill(undefined),drafts:[],sending:false};
    } else if(!force) return;
    const state = questionView, question = pending.questions[state.index];
    node.replaceChildren();
    const title = element('h3',question.prompt);title.id='agent-card-question';title.tabIndex=-1;
    const header = element('div',undefined,'agent-question-header');
    const nav = element('div',undefined,'agent-question-nav');
    function control(symbol,label,action,disabled=false) {
      const button = element('button');
      button.type='button';button.title=label;button.setAttribute('aria-label',label);
      button.disabled=state.sending||disabled;button.append(icon(symbol));button.onclick=action;
      return button;
    }
    function move(index) { state.index=index;renderQuestionCard(true);$('#agent-card-question').focus({preventScroll:true}); }
    if(pending.questions.length>1)nav.append(
      control('chevron-left','上一题',()=>move(state.index-1),state.index===0),
      element('span',`${state.index+1}/${pending.questions.length}`),
      control('chevron-right','下一题',()=>move(state.index+1),state.index===pending.questions.length-1)
    );
    nav.append(control('x','跳过所有未回答的问题',()=>{
      state.answers=state.answers.map(answer=>answer??null);
      void sendQuestionAnswers(state);
    }));
    header.append(title,nav);node.append(header);
    function choose(answer) {
      state.answers[state.index]=answer;
      const next=state.answers.findIndex((value,index)=>index>state.index&&value===undefined);
      const unanswered=next<0?state.answers.indexOf(undefined):next;
      if(unanswered<0)void sendQuestionAnswers(state);
      else move(unanswered);
    }
    const options=element('div',undefined,'agent-question-options');
    question.options.forEach((option,index)=>{
      const button=element('button',undefined,'agent-question-option');
      button.type='button';button.disabled=state.sending;button.setAttribute('aria-pressed',String(state.answers[state.index]===option));
      button.append(element('span',String(index+1)),element('span',option),icon('arrow-right'));
      button.onclick=()=>choose(option);options.append(button);
    });
    const custom=element('form',undefined,'agent-question-custom');
    const input=element('input');input.type='text';input.placeholder=question.options.length?'其他补充…':'请输入回答…';input.maxLength=600;
    input.setAttribute('aria-label','自定义回答');input.value=state.drafts[state.index]??'';input.disabled=state.sending;
    const accept=element('button');accept.type='submit';accept.title='提交自定义回答';accept.setAttribute('aria-label',accept.title);
    accept.append(icon('arrow-right'));accept.disabled=state.sending||!input.value.trim();
    input.oninput=()=>{state.drafts[state.index]=input.value;accept.disabled=!input.value.trim();};
    custom.onsubmit=event=>{event.preventDefault();const answer=input.value.trim();if(answer&&!state.sending)choose(answer);};
    custom.append(icon('pencil'),input,accept);
    const footer=element('div',undefined,'agent-question-footer');
    const skip=element('button',state.sending?'正在提交…':'跳过');skip.type='button';skip.disabled=state.sending;skip.onclick=()=>choose(null);
    footer.append(skip);node.append(options,custom);
    if(state.error){const error=element('p',state.error,'inline-error');error.setAttribute('role','alert');node.append(error);}
    node.append(footer);
    icons();
  }
  async function sendQuestionAnswers(state) {
    if(state.sending||busy||state!==questionView||sessionLoading)return;
    const id=selectedTask.id, revision=++generation;
    state.sending=true;state.error='';busy=true;renderQuestionCard(true);updateControls();
    try {
      const task=await api(`agent/tasks/${id}/question-answer`,'POST',{question_id:state.id,answers:state.answers});
      if(revision!==generation||selectedTask?.id!==id)return;
      selectedTask=task;
      taskList=taskList.map(entry=>entry.id===id?task:entry);
      modelStatus.active_task_ids=[...new Set([...(modelStatus.active_task_ids??[]),id])];
      modelStatus.active_task_id=modelStatus.active_task_ids[0];
      modelStatus.active_connection_id=task.connection_id;
      renderTask();renderHistory();pollError('');
      await loadConversation();
    }catch(error){if(revision===generation)state.error=error.message;}
    finally {
      state.sending=false;busy=false;
      if(state===questionView)renderQuestionCard(true);
      updateControls();schedule();
    }
  }
  function loadEarlierAtTop() {
    if (chatScroll.clientHeight && chatScroll.scrollTop <= 32) void loadConversation(true);
  }
  async function loadConversation(older = false) {
    if (!selectedTask || older && (chatTaskId !== selectedTask.id || !chatCursor || earlierRequest === generation)) return;
    const id = selectedTask.id, revision = generation;
    const before = older ? chatCursor : undefined;
    if (older) earlierRequest = revision;
    let fillViewport = false;
    try {
      const result = await api(`agent/tasks/${id}/conversation${before ? '?before=' + encodeURIComponent(before) : ''}`);
      if (revision !== generation || selectedTask?.id !== id) return;
      const same = chatTaskId === id;
      const existing = same ? chatMessages : [];
      const merged = older ? [...result.messages,...existing] : [...existing,...result.messages];
      chatMessages = [...new Map(merged.map(message => [message.id,message])).values()];
      if (!same || older || chatCursor === undefined) chatCursor = result.next_cursor === before ? null : result.next_cursor;
      const history = $('#agent-chat-history');
      const top = chatScroll.scrollTop, height = older ? history.offsetHeight : 0;
      chatTaskId = id; renderChatHistory();
      const added = older ? history.offsetHeight - height : 0;
      if (older && added > 0) chatScroll.scrollTop = top + added;
      updateScrollBottom();
      fillViewport = chatScroll.scrollHeight <= chatScroll.clientHeight || older && added === 0;
    } catch (error) { if (revision === generation) pollError('对话历史暂时无法加载。' + error.message); }
    finally { if (older && earlierRequest === revision) earlierRequest = undefined; }
    if (fillViewport) loadEarlierAtTop();
  }
  async function pinTask(task) {
    cancelSessionSelection();
    if(busy||!terminal(task))return;busy=true;updateControls();
    try{const updated=await api('agent/tasks/'+task.id,'PATCH',{pinned:!task.pinned});if(selectedTask?.id===updated.id)selectedTask=updated;busy=false;await load();}
    catch(error){toast(error.message,true);}finally{busy=false;updateControls();}
  }
  function editSessionTitle(task,row) {
    cancelSessionSelection();if(busy||!terminal(task)||editingTitle)return;
    editingTitle=task.id;row.classList.add('editing');
    const input=element('input',undefined,'session-title-input');input.value=task.title;input.maxLength=80;input.setAttribute('aria-label','会话标题');
    row.replaceChildren(input);input.focus();input.select();
    let finished=false;
    const finish=async save=>{
      if(finished)return;finished=true;const title=input.value.trim();editingTitle=undefined;
      if(!save||!title||title===task.title){renderHistory();return;}
      input.disabled=true;busy=true;updateControls();
      try{const updated=await api('agent/tasks/'+task.id,'PATCH',{title});if(selectedTask?.id===updated.id)selectedTask=updated;busy=false;await load();}
      catch(error){toast(error.message,true);renderHistory();}finally{busy=false;updateControls();}
    };
    input.onkeydown=event=>{if(event.isComposing)return;if(event.key==='Enter'){event.preventDefault();void finish(true);}else if(event.key==='Escape'){event.preventDefault();void finish(false);}};
    input.onblur=()=>void finish(true);
  }
  function renderHistory() {
    if(editingTitle||selectionTimer)return;
    const list=$('#agent-history');list.replaceChildren(new Option('新对话',''));
    const current=$('#agent-connection').value,query=$('#agent-session-search').value.trim().toLowerCase();
    const tasks=taskList.filter(task=>task.connection_id===current),node=$('#agent-session-list');node.replaceChildren();
    for(const task of tasks){
      list.append(new Option((task.pinned?'★ ':'')+task.title,task.id));
      if(query&&!(task.title+' '+task.prompt).toLowerCase().includes(query))continue;
      const row=element('div',undefined,'session-item'+(task.id===selectedTask?.id?' selected':''));row.dataset.taskId=task.id;
      const select=element('button',undefined,'session-select');select.type='button';select.disabled=busy;select.title=task.title;
      select.setAttribute('aria-pressed',String(task.id===selectedTask?.id));select.append(element('strong',task.title));
      let previousSelection;
      const choose=()=>{list.value=task.id;list.dispatchEvent(new Event('change'));};
      select.onclick=event=>{cancelSessionSelection();if(event.detail>1)return;
        previousSelection=selectedTask?.id;
        if(event.detail!==0)selectionTimer=setTimeout(()=>{selectionTimer=undefined;renderHistory();},400);
        choose();};
      select.ondblclick=()=>{
        editSessionTitle(task,row);
        if(previousSelection===task.id)return;
        if(previousSelection){list.value=previousSelection;void selectSession(previousSelection);}
        else {const draft=$('#agent-prompt').value;$('#agent-new').click();$('#agent-prompt').value=draft;updateControls();}
      };
      select.onkeydown=event=>{if(event.key==='F2'){event.preventDefault();editSessionTitle(task,row);}};
      const actions=element('div',undefined,'session-row-actions');
      const pin=element('button',undefined,'session-pin'+(task.pinned?' pinned':''));pin.type='button';pin.disabled=busy||!terminal(task);
      pin.title=task.pinned?'取消置顶':'置顶';pin.setAttribute('aria-label',pin.title);pin.setAttribute('aria-pressed',String(task.pinned));pin.append(icon('pin'));pin.onclick=()=>void pinTask(task);
      const remove=element('button',undefined,'session-delete');remove.type='button';remove.disabled=busy||!terminal(task);remove.title='删除';remove.setAttribute('aria-label','删除');remove.append(icon('trash-2'));remove.onclick=()=>openManage('delete',task);
      actions.append(pin,remove);row.append(select,actions);node.append(row);
    }
    list.value=selectedTask?.id||'';
    $('#agent-sessions-empty').hidden=node.childElementCount>0;
    $('#agent-sessions-empty').textContent=!current?'选择系统后查看会话':query?'没有匹配的会话':'这个系统还没有会话，点击“新对话”开始。';
    icons();
  }
  function renderReport() {
    const task=selectedTask,value=reportTaskId===task?.id?reportValue:undefined;
    if(!task||reportTaskId!==task.id){$('#agent-report-library').hidden=true;$('#agent-report-menu').hidePopover();}
    const pending=task&&!sessionDetailLoading&&!sessionLoadFailed&&task.output_mode==='report'&&!terminal(task)&&(task.report_target_id?task.report_target_id===currentReportId:!currentReportId);
    const draft=pending&&!task.live?.finished?task.live?.text:'';
    const text=draft||value?.content;
    $('#agent-report-empty').hidden=Boolean(text);$('#agent-report-content').hidden=!text;
    const key=`${task?.id}:${currentReportId}:${value?.id}:${draft?task.live.revision:''}:${Boolean(text)}`;
    if(key!==reportDrawKey){reportDrawKey=key;if(text)renderStructuredReport(text,draft?undefined:value);else $('#agent-report-content').replaceChildren();}
    $('#agent-report-state').textContent=sessionDetailLoading||reportLoading?'加载中':sessionLoadFailed?'加载失败':pending?'正在生成':value?'已保存':'尚未生成';
    $('#agent-report-empty h2').textContent=sessionDetailLoading||reportLoading?'正在加载报告…':sessionLoadFailed?'报告暂不可用':'暂无报告';
    $('#agent-report-length').textContent=text?`${Array.from(text).length.toLocaleString('zh-CN')} 字符`:'';
    const connection=connections.find(c=>c.connection_id===$('#agent-connection').value);
    $('#agent-report-target').textContent=connection?(task?`${connection.name} · Client ${task.client}`:connectionLabel(connection)):'尚未选择系统';
  }
  function renderStructuredReport(text,report) {
    const node=$('#agent-report-content'),categories=window.SapLinkReport.sections(text),parsed=window.SapLinkReport.parse(text);
    let root;
    node.replaceChildren();node.classList.add('report-layout');
    const bar=element('div',undefined,'report-tabs');bar.setAttribute('role','tablist');bar.setAttribute('aria-label','报告内容');node.append(bar);
    const tabKey=selectedTask?.id+':'+(currentReportId??'pending'),panes=[];const current=reportTabs.get(tabKey);
    const activate=(name,reset=false)=>{reportTabs.set(tabKey,name);for(const item of panes){const active=item.name===name;item.button.setAttribute('aria-selected',String(active));item.button.tabIndex=active?0:-1;item.panel.hidden=!active;}if(reset)node.closest('.report-scroll').scrollTop=0;};
    const section=(title,caption)=>{
      const card=element('section',undefined,'report-section'),head=element('div',undefined,'report-section-heading');
      head.append(element('h3',title));if(caption)head.append(element('span',caption));card.append(head);root.append(card);return card;
    };
    for(const [index,category] of categories.entries()){
      const button=element('button',category.name,'report-tab');button.type='button';button.setAttribute('role','tab');button.id='report-tab-'+index;
      const panel=element('div',undefined,'report-tab-panel');panel.id='report-tab-panel-'+index;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);button.setAttribute('aria-controls',panel.id);
      bar.append(button);node.append(panel);root=panel;panes.push({name:category.name,button,panel});button.onclick=()=>activate(category.name,true);
      button.onkeydown=event=>{let next;if(event.key==='ArrowRight')next=(index+1)%categories.length;else if(event.key==='ArrowLeft')next=(index+categories.length-1)%categories.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=categories.length-1;else return;event.preventDefault();activate(categories[next].name,true);panes[next].button.focus();};
      if(category.name!=='对象'){
        for(const block of window.SapLinkReport.blocks(category.content,category.name)){
          const metrics=category.name==='影响分析'&&block.title==='影响摘要'?window.SapLinkReport.metrics(block.content):[];
          if(metrics.length){const stats=element('div',undefined,'report-stats');for(const item of metrics){const card=element('div',undefined,'report-stat'+(item.label==='风险等级'?' report-risk-level':''));card.append(element('span',item.label),element('strong',item.value));stats.append(card);}root.append(stats);continue;}
          const card=section(block.title,category.name==='改造建议'?'未执行写入':undefined),body=element('div',undefined,'report-analysis'+(['核心调用链','业务流程'].includes(block.title)?' report-flow':''));
          if(block.title==='风险点')body.classList.add('report-risks');
          if(block.title==='回归范围')body.classList.add('report-regression');
          renderAnswer(block.content.replace(/^#{1,4}\s+分析结论\s*\n/,''),body);card.append(body);
        }
        continue;
      }
      const stats=element('div',undefined,'report-stats');
    ['ABAP程序/类','相关表','配置项','关键接口'].forEach((label,index)=>{
      const card=element('div',undefined,'report-stat');card.title='仅统计本报告对象表中列出的对象';
      card.append(element('span',label),element('strong',parsed.counts?String(parsed.counts[index]):'—'));stats.append(card);
    });if(parsed.objects.length)root.append(stats);
    const connection=connections.find(c=>c.connection_id===selectedTask?.connection_id);
    const inventory=section('已定位关键对象',connection?`${connection.name} · Client ${selectedTask.client}`:undefined);
    if(parsed.objects.length){
      const wrap=element('div',undefined,'report-inventory'),table=element('table'),head=element('thead'),row=element('tr');
      ['对象','类型','用途','关联'].forEach(label=>row.append(element('th',label)));head.append(row);table.append(head);
      const body=element('tbody');
      for(const object of parsed.objects){const row=element('tr');for(const key of ['name','type','purpose','relation'])row.append(element('td',object[key]));body.append(row);}
      table.append(body);wrap.append(table);inventory.append(wrap);
    }else inventory.append(element('p','本报告尚未整理对象清单。','report-placeholder'));
    const tools=section('工具调用记录',report?.tools_partial?'近期记录':undefined),chips=element('div',undefined,'report-tool-records');
    if(report?.tools?.length){for(const record of report.tools){
      const chip=element('span',`${toolNames[record.name]??record.name} · ${record.completed+record.failed}`,`report-tool-chip ${record.failed?'has-failure':'succeeded'}`);
      chip.title=`${record.name}：成功 ${record.completed} 次，失败 ${record.failed} 次`;chips.append(chip);
    }}else chips.append(element('span',report?.tools?'未调用工具':'未保存工具记录','report-placeholder'));
    tools.append(chips);
    const objectNotes=window.SapLinkReport.parse(category.content).body;
    if(objectNotes.trim()){const notes=section('对象说明'),body=element('div',undefined,'report-analysis');renderAnswer(objectNotes,body);notes.append(body);}
    }
    if(categories.length)activate(categories.some(item=>item.name===current)?current:categories[0].name);
  }
  function rememberReport(id,value){if(value)reportChoices.set(id,value);else reportChoices.delete(id);try{if(value)sessionStorage.setItem('saplink.agent.report:'+id,value);else sessionStorage.removeItem('saplink.agent.report:'+id);}catch{}}
  async function loadReport(manual=false) {
    const id=selectedTask?.id,revision=generation,request=++reportRequest;
    if(!id){reportTaskId=undefined;currentReportId=undefined;reportValue=undefined;reportLoading=false;$('#agent-report-library').hidden=true;renderReport();return;}
    if(reportTaskId!==id){reportTaskId=id;currentReportId=undefined;reportValue=undefined;reportDrawKey=undefined;}
    reportLoading=true;renderReport();updateControls();
    try{
      const list=await api('agent/tasks/'+id+'/reports');if(request!==reportRequest||revision!==generation||selectedTask?.id!==id)return;
      let saved=reportChoices.get(id);try{saved??=sessionStorage.getItem('saplink.agent.report:'+id);}catch{}
      if(!manual&&reportHeads.has(id)&&reportHeads.get(id)!==list.active_report_id)saved=list.active_report_id;
      reportHeads.set(id,list.active_report_id);
      const pending=selectedTask.output_mode==='report'&&!terminal(selectedTask)&&!selectedTask.report_target_id&&!saved;
      currentReportId=pending?undefined:list.reports.find(report=>report.id===saved)?.id??selectedTask.report_target_id??list.active_report_id??list.reports.at(-1)?.id;
      const select=$('#agent-report-history');select.replaceChildren();
      if(pending){const option=new Option('正在生成新报告','');option.disabled=true;select.append(option);}
      list.reports.forEach(report=>select.append(new Option(report.title,report.id)));
      select.value=currentReportId??'';$('#agent-report-library').hidden=!list.reports.length&&!pending;
      $('#agent-report-name').textContent=pending?'正在生成新报告':list.reports.find(report=>report.id===currentReportId)?.title??'选择报告';
      $('#agent-report-count').textContent=list.reports.length>1?list.reports.length+' 份':'';
      const menu=$('#agent-report-menu');menu.replaceChildren();
      for(const report of list.reports){
        const row=element('div',undefined,'report-row');
        const option=element('button',undefined,'report-option');option.type='button';option.dataset.reportId=report.id;option.setAttribute('aria-pressed',String(report.id===currentReportId));option.title=report.title;
        const check=icon('check');check.className='report-option-check';if(report.id!==currentReportId)check.hidden=true;
        option.append(icon('file-text'),element('span',report.title),check);
        option.onclick=()=>{menu.hidePopover();select.value=report.id;select.dispatchEvent(new Event('change'));$('#agent-report-switcher').focus();};
        const actions=element('div',undefined,'report-row-actions');
        for(const [mode,label,symbol] of [['report-rename','重命名','pencil'],['report-delete','删除','trash-2']]){
          const button=element('button',undefined,mode);button.type='button';button.title=label;button.setAttribute('aria-label',label+'报告：'+report.title);button.disabled=busy||!terminal(selectedTask);
          button.append(icon(symbol));button.onclick=()=>{menu.hidePopover();openManage(mode,selectedTask,report);};actions.append(button);
        }
        row.append(option,actions);menu.append(row);
      }
      icons();
      if(reportValue?.report_id!==currentReportId){reportValue=undefined;reportDrawKey=undefined;renderReport();}
      if(currentReportId){const result=await api('agent/tasks/'+id+'/report?report_id='+encodeURIComponent(currentReportId));if(request!==reportRequest||revision!==generation||selectedTask?.id!==id)return;reportValue=result.report;rememberReport(id,currentReportId);}
      else reportValue=undefined;
    }catch(error){if(request===reportRequest&&revision===generation)pollError('报告暂时无法加载。'+error.message);}
    finally{if(request===reportRequest&&revision===generation){reportLoading=false;renderReport();updateControls();}}
  }
  function renderSetup() {
    const note = $('#agent-notice');
    const needsModel = modelStatus?.configured === false;
    note.hidden = Boolean(modelStatus?.configured && $('#agent-connection').value);
    $('#agent-configure-model').hidden = !needsModel;
    const modelNotice = modelStatus?.key_source === 'unavailable'
      ? '无法读取已保存的 DeepSeek API Key，请重新配置。' : '请配置 DeepSeek API Key 后开始对话。';
    $('#agent-notice-text').textContent = needsModel
      ? (connections.length ? modelNotice : '先添加一个 SAP 连接。' + modelNotice)
      : !connections.length ? '先添加一个 SAP 连接，再开始分析。'
        : '请选择本次分析的 SAP 系统，之后会记住你的选择。';
    const connection = connections.find(item => item.connection_id === $('#agent-connection').value);
    renderWriteMode();
    const modelText = modelStatus?.configured ? modelNames[modelStatus.model] || modelStatus.model : '模型未配置';
    $('#agent-model-label span').textContent = modelText;
    $('#agent-model-label').title = '选择模型';
    $('#agent-model-label').setAttribute('aria-label','选择模型，当前模型 '+modelText);
    const effort = { low:'低', high:'中', max:'高' }[modelStatus?.reasoning_effort] ?? '中';
    $('#agent-reasoning-value').textContent = effort;
    const contextPreset = {128000:'128K',512000:'512K',1000000:'1M'}[modelStatus?.context_tokens] ?? '512K';
    $('#agent-context-value').textContent = contextPreset;
    $('#agent-model-tuning').setAttribute('aria-label',`推理强度 ${effort}，上下文 ${contextPreset}`);
    const used = selectedTask?.context_estimated_tokens;
    const limit = selectedTask?.context_tokens ?? modelStatus?.context_tokens;
    const hasContext = Number.isFinite(used) && Number.isFinite(limit) && limit > 0;
    const percent = hasContext ? Math.round(used / limit * 100) : undefined;
    $('#agent-context-amount').textContent = hasContext ? '约 ' + used.toLocaleString('zh-CN') + ' / ' + limit.toLocaleString('zh-CN') + ' Token'
      : selectedTask && !Number.isFinite(used) ? '正在加载' : selectedTask ? '整理阈值暂无数据' : '新对话暂无数据';
    $('#agent-context-percent').textContent = hasContext ? percent + '%' : '--';
    $('#agent-context-progress').style.width = Math.min(100, percent ?? 0) + '%';
    const total = selectedTask?.model_usage?.total_tokens;
    $('#agent-context-usage').textContent = Number.isFinite(total) ? total.toLocaleString('zh-CN') + ' Token' : '暂无数据';
    $('#agent-context-usage-note').textContent = '包含已返回用量的模型请求；失败或中断请求可能缺失，不等于账单。';
    const last = selectedTask?.last_model_input_tokens;
    $('#agent-context-last').textContent = Number.isFinite(last) ? last.toLocaleString('zh-CN') + ' Token' : '暂无数据';
    $('#agent-data-policy').textContent = connection?.allow_table_data
      ? '表数据访问已开启，读取结果会发送至 DeepSeek 用于分析。'
      : '表数据访问未开启；可以正常分析代码和表结构。';
    $('#agent-settings').title='模型设置';
    updateControls();
  }
  function pollError(message, fromPolling = false) {
    errorFromPolling = fromPolling;
    $('#agent-poll-error').textContent = message;
    $('#agent-poll-error').hidden = !message;
    $('#agent-retry-poll').hidden = !message;
  }
  function schedule() {
    clearTimeout(timer);
    if (!view.hidden && !document.hidden) timer = setTimeout(() => void poll(), 1500);
  }
  async function poll() {
    if (pollRunning || view.hidden || document.hidden) return;
    if (busy || sessionLoading || sessionLoadFailed) { schedule(); return; }
    pollRunning = true;
    const revision = generation, id = selectedTask?.id;
    try {
      const [status,latest] = await Promise.all([api('agent/status'),api('state')]);
      if (revision !== generation) return;
      if (status.active_connection_id && status.active_connection_id !== $('#agent-connection').value &&
          latest.connections.some(connection => connection.connection_id === status.active_connection_id)) {
        await load();
        return;
      }
      const detail = id ? await api(`agent/tasks/${id}`) : undefined;
      const connectionId=$('#agent-connection').value;
      const history = connectionId ? await api('agent/tasks?connection_id='+encodeURIComponent(connectionId)) : undefined;
      if (revision !== generation) return;
      const changed = detail && (detail.id !== selectedTask?.id || detail.updated_at !== selectedTask.updated_at ||
        detail.status !== selectedTask.status || detail.events.length !== selectedTask.events?.length || detail.answer !== selectedTask.answer);
      const reportChanged=detail&&detail.report_updated_at!==selectedTask?.report_updated_at;
      const guidanceChanged=detail?.events.some(event=>event.type==='user_guidance'&&event.sequence>(selectedTask?.event_count??0));
      modelStatus = status;connections=latest.connections;
      if (history) taskList = history.tasks;
      if (detail) {
        if(!terminal(detail)&&(!streamSession?.http||detail.live?.finished))detail.live=selectedTask?.live;
        else if (detail.live?.run_id === selectedTask?.live?.run_id && detail.live?.revision < selectedTask.live.revision) detail.live=selectedTask.live;
        selectedTask = detail;
        taskList = taskList.map(task => task.id === detail.id ? detail : task);
      }
      // Keep text selection and open technical details stable while reading a
      // completed answer. Polling must not recreate unchanged result nodes.
      if (changed) renderTask();
      else if (detail?.live && !terminal(detail)) drawDraft(detail.live);
      if (changed && detail && terminal(detail)) await Promise.all([loadConversation(),loadReport()]);
      else if(reportChanged||guidanceChanged)await Promise.all([reportChanged&&loadReport(),guidanceChanged&&loadConversation()]);
      if (changed || history) renderHistory();
      renderSetup();renderActivity();
      ensureStreaming();
      if (errorFromPolling) pollError('');
    } catch (error) {
      if (revision === generation) pollError('暂时无法刷新任务状态。' + error.message, true);
    } finally { pollRunning = false; schedule(); }
  }
  async function load() {
    if (busy) return;
    sessionLoading=false;sessionDetailLoading=false;sessionLoadFailed=false;reportLoading=false;
    const revision = ++generation; busy = true; updateControls();
    try {
      const [status, latest] = await Promise.all([api('agent/status'), api('state')]);
      if (revision !== generation) return;
      modelStatus = status; connections = latest.connections;
      const current = [status.active_connection_id,$('#agent-connection').value,initialPage.get('connection'),rememberedConnection()]
        .find(id=>connections.some(connection=>connection.connection_id===id));
      const select = $('#agent-connection'); select.replaceChildren();
      if(!connections.length){const empty=new Option('暂无 SAP 系统','');empty.disabled=true;select.append(empty);}
      for (const c of connections) select.append(new Option(connectionLabel(c), c.connection_id));
      if (connections.some(c => c.connection_id === current)) select.value = current;
      else if (connections.length) select.value = connections[0].connection_id;
      if (select.value) rememberConnection();
      await loadSystemSessions(revision); pollError('');
    } catch (error) { if (revision === generation) pollError(error.message); }
    finally { busy = false; updateControls(); schedule(); }
  }
  async function loadSystemSessions(revision) {
    const connectionId = $('#agent-connection').value;
    const history = connectionId ? await api('agent/tasks?connection_id=' + encodeURIComponent(connectionId)) : {tasks:[]};
    if(revision !== generation || connectionId !== $('#agent-connection').value)return;
    taskList = history.tasks;
    const saved = rememberedTask();
    const id = selectedTask?.connection_id === connectionId ? selectedTask.id
      : taskList.find(task=>task.id===modelStatus?.active_task_id)?.id || (saved==='new'?undefined:taskList.find(task=>task.id === saved)?.id || taskList[0]?.id);
    const task = id ? await api('agent/tasks/' + id) : undefined;
    if(revision !== generation || connectionId !== $('#agent-connection').value)return;
    selectedTask = task?.connection_id === connectionId ? task : undefined;
    if(selectedTask)rememberTask();
    renderTask(); renderHistory(); renderSetup();
    await Promise.all([loadConversation(), loadReport()]);
  }
  const nav = element('button', undefined, 'nav'); nav.dataset.view = 'agent';
  nav.append(icon('sparkles'), document.createTextNode('工作空间'));
  $('.sidebar nav').prepend(nav);
  nav.onclick = () => { showView('agent'); void load(); };
  $('#agent-connections').onclick = () => showView('connections');
  function positionComposerMenu(button, menu) {
    const rect=button.getBoundingClientRect(),writeMenu=menu.id==='agent-write-menu',connectionMenu=menu.id==='agent-connection-menu';
    const leftAligned=writeMenu || connectionMenu || menu.id==='agent-add-menu';
    const skillMenu=menu.id==='agent-skill-add-menu';
    const width=Math.min(Math.max(rect.width,connectionMenu?208:skillMenu?180:writeMenu?320:340),innerWidth-24);
    menu.style.width=width+'px';menu.style.left=Math.max(12,Math.min(leftAligned?rect.left:rect.right-width,innerWidth-width-12))+'px';
    const below=(skillMenu||connectionMenu)&&rect.bottom+menu.offsetHeight+20<=innerHeight;
    menu.style.top=Math.max(12,Math.min(below?rect.bottom+8:rect.top-menu.offsetHeight-8,innerHeight-menu.offsetHeight-12))+'px';
  }
  function openComposerMenu(button,menu,items,current,onSelect) {
    if(menu.matches(':popover-open')){menu.hidePopover();return;}
    const options = menu.id==='agent-model-menu' ? $('#agent-model-options') : menu;
    options.replaceChildren();
    if(menu.id==='agent-write-menu')menu.append(element('p','客户端写入权限','write-menu-heading'));
    for(const item of items){
      const option=element('button',undefined,'report-option');option.type='button';
      option.setAttribute('aria-pressed',String(item.value===current));option.dataset.value=item.value;option.title=item.label;
      const check=icon('check');check.className='report-option-check';check.hidden=item.value!==current;
      const text=element('span',undefined,'composer-option-text');text.append(element('span',item.label));
      if(item.description)text.append(element('small',item.description));
      if(item.icon)option.append(icon(item.icon));
      if(item.warning)option.classList.add('write-full');
      option.append(text,check);
      option.onclick=()=>{menu.hidePopover();button.focus();if(item.value!==current)onSelect(item.value);};
      options.append(option);
    }
    icons();updateControls();menu.showPopover();
    positionComposerMenu(button,menu);
    (menu.querySelector('[aria-pressed=true]:enabled')??menu.querySelector('button:enabled'))?.focus();
  }
  const skillAddButton=$('#agent-skill-add'),skillAddMenu=$('#agent-skill-add-menu');
  const connectionPicker=$('#agent-connection-picker'),connectionMenu=$('#agent-connection-menu');
  for (const [button,menu] of [[$('#agent-model-label'),$('#agent-model-menu')],[$('#agent-model-tuning'),$('#agent-tuning-menu')],[$('#agent-write-mode'),$('#agent-write-menu')],[skillAddButton,skillAddMenu],[connectionPicker,connectionMenu]]) {
    const reposition=()=>{if(menu.matches(':popover-open'))positionComposerMenu(button,menu);};
    window.addEventListener('resize',reposition);window.addEventListener('scroll',reposition,true);
    menu.addEventListener('toggle',()=>{
      const expanded=String(menu.matches(':popover-open'));
      button.setAttribute('aria-expanded',expanded);
    });
    menu.onkeydown=event=>{
      if(event.key==='Escape'){event.preventDefault();menu.hidePopover();button.focus();return;}
      const options=[...menu.querySelectorAll('button:enabled')],index=options.indexOf(document.activeElement);let next;
      if(!options.length)return;
      if(event.key==='ArrowDown')next=(index+1)%options.length;
      else if(event.key==='ArrowUp')next=(index+options.length-1)%options.length;
      else if(event.key==='Home')next=0;else if(event.key==='End')next=options.length-1;else return;
      event.preventDefault();options[next]?.focus();
    };
  }
  connectionPicker.onclick=()=>{
    const select=$('#agent-connection');
    if(select.disabled)return;
    const items=[...select.options].filter(option=>!option.disabled).map(option=>({value:option.value,label:option.text}));
    openComposerMenu(connectionPicker,connectionMenu,items,select.value,value=>{
      if(select.disabled)return;
      select.value=value;
      select.dispatchEvent(new Event('change',{bubbles:true}));
    });
  };
  $('#agent-model-label').onclick=()=>{
    if(!modelStatus?.configured||['none','unavailable'].includes(modelStatus.key_source)){$('#agent-settings').click();return;}
    const items=Object.entries(modelNames).map(([value,label])=>({value,label}));
    openComposerMenu($('#agent-model-label'),$('#agent-model-menu'),items,modelStatus.model,value=>void switchModel(value));
  };
  $('#agent-model-tuning').onclick=()=>{
    if(!modelStatus?.configured||['none','unavailable'].includes(modelStatus.key_source)){$('#agent-settings').click();return;}
    const menu=$('#agent-tuning-menu'), button=$('#agent-model-tuning');
    if(menu.matches(':popover-open')){menu.hidePopover();return;}
    $('#agent-context-details').open=false;
    updateModelTuning();updateControls();menu.showPopover();positionComposerMenu(button,menu);
    (menu.querySelector('[aria-pressed=true]:enabled')??menu.querySelector('button:enabled'))?.focus();
  };
  $('#agent-context-details').addEventListener('toggle',()=>{
    const menu=$('#agent-tuning-menu');
    if(menu.matches(':popover-open'))positionComposerMenu($('#agent-model-tuning'),menu);
  });
  function updateModelTuning() {
    for (const option of $('#agent-reasoning-options').querySelectorAll('button')) {
      option.setAttribute('aria-pressed',String(option.dataset.value === (modelStatus?.reasoning_effort ?? 'high')));
    }
    for (const option of $('#agent-context-options').querySelectorAll('button')) {
      option.setAttribute('aria-pressed',String(Number(option.dataset.value) === (modelStatus?.context_tokens ?? 512000)));
    }
  }
  async function saveModelTuning(value, field = 'reasoning_effort') {
    if(busy||modelStatus?.active_task_id||!modelStatus?.configured)return;
    const focused = document.activeElement;
    busy=true;generation++;updateControls();
    try {
      const saved=await api('agent/model','PUT',{model:modelStatus.model,[field]:value});
      if(!saved.configured)throw new Error('设置已保存，但无法读取密钥，请检查模型设置。');
      modelStatus={...modelStatus,...saved};updateModelTuning();renderSetup();
      toast('模型设置已保存，下次发送或继续时生效');
    } catch(error) { pollError(error.message); }
    finally {
      busy=false;updateControls();
      if(document.activeElement===document.body && $('#agent-tuning-menu').matches(':popover-open') && focused instanceof HTMLButtonElement && !focused.disabled) focused.focus();
      schedule();
    }
  }
  for (const option of $('#agent-reasoning-options').querySelectorAll('button'))
    option.onclick=()=>void saveModelTuning(option.dataset.value);
  for (const option of $('#agent-context-options').querySelectorAll('button'))
    option.onclick=()=>void saveModelTuning(Number(option.dataset.value),'context_tokens');
  $('#agent-write-mode').onclick = () => {
    if ($('#agent-write-mode').disabled || $('#agent-write-mode').hidden) return;
    openComposerMenu($('#agent-write-mode'),$('#agent-write-menu'),[
      { value:'controlled', label:'受控写入', icon:'shield-check', description:'修改前审核变更并确认执行' },
      { value:'unrestricted', label:'完全写入', icon:'shield-alert', warning:true, description:'按任务直接执行，无需逐项审批' }
    ], chosenWriteMode(), value => void switchWriteMode(value));
  };
  async function switchWriteMode(mode) {
    if (busy || modelStatus?.active_task_id) return;
    const id = $('#agent-connection').value;
    if (!connections.find(item => item.connection_id === id)?.write_enabled) return;
    busy = true; generation++; updateControls();
    try {
      if (selectedTask) {
        const saved = await api(`agent/tasks/${selectedTask.id}/write-mode`, 'PATCH', {mode});
        selectedTask = { ...selectedTask, ...saved };
      }
      try { localStorage.setItem('saplink.agent.write-mode:' + id, mode); } catch {}
      renderSetup();
    } catch (error) { toast(error.message, true); }
    finally { busy = false; updateControls(); schedule(); }
  }
  async function switchModel(model){
    if(busy||modelStatus?.active_task_id)return;
    busy=true;generation++;updateControls();
    try{
      const saved=await api('agent/model','PUT',{model});
      if(!saved.configured)throw new Error('模型已切换，但无法读取密钥，请检查模型设置。');
      modelStatus={...modelStatus,...saved};renderSetup();toast('模型已切换');
    }catch(error){pollError(error.message);}
    finally{busy=false;updateControls();schedule();}
  }
  $('#agent-compact').onclick = () => {
    const id = selectedTask?.id;
    if (!id || $('#agent-compact').disabled) return;
    $('#agent-tuning-menu').hidePopover();
    confirmAction('压缩对话', '将调用当前模型整理工作上下文，可能产生 Token 消耗。原始对话会保留，但摘要可能遗漏细节。是否继续？', async () => {
      if (busy || selectedTask?.id !== id) return;
      busy = true; updateControls();
      try {
        selectedTask = await api(`agent/tasks/${id}/compact`, 'POST', { confirm: true });
        renderTask(); renderHistory(); renderSetup(); pollError('');
        toast('工作上下文已整理，原始对话已保留。');
      } catch (error) { pollError(error.message); }
      finally { busy = false; updateControls(); schedule(); }
    }, false);
  };
  $('#agent-session-search').oninput=renderHistory;
  $('#agent-search-toggle').onclick=()=>{
    const input=$('#agent-session-search'),expanded=input.hidden;
    input.hidden=!expanded;$('#agent-search-toggle').setAttribute('aria-expanded',String(expanded));
    if(expanded)input.focus();
    else{input.value='';renderHistory();}
  };
  $('#agent-report-history').onchange=()=>{rememberReport(selectedTask.id,$('#agent-report-history').value);reportValue=undefined;reportDrawKey=undefined;void loadReport(true);};
  $('#agent-report-switcher').onclick=()=>{
    const menu=$('#agent-report-menu'),button=$('#agent-report-switcher');
    if(menu.matches(':popover-open')){menu.hidePopover();return;}
    menu.showPopover();const rect=button.getBoundingClientRect(),width=Math.min(Math.max(rect.width,280),innerWidth-24);
    menu.style.width=width+'px';menu.style.left=Math.max(12,Math.min(rect.left,innerWidth-width-12))+'px';
    menu.style.top=Math.max(12,Math.min(rect.bottom+6,innerHeight-menu.offsetHeight-12))+'px';
    (menu.querySelector('.report-option[aria-pressed=true]')??menu.querySelector('.report-option'))?.focus();
  };
  $('#agent-report-menu').addEventListener('toggle',()=>$('#agent-report-switcher').setAttribute('aria-expanded',String($('#agent-report-menu').matches(':popover-open'))));
  $('#agent-report-menu').onkeydown=event=>{
    const options=[...$('#agent-report-menu').querySelectorAll('.report-option')],index=options.indexOf(document.activeElement);let next;
    if(index<0&&event.key!=='Escape')return;
    if(event.key==='ArrowDown')next=(index+1)%options.length;else if(event.key==='ArrowUp')next=(index+options.length-1)%options.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=options.length-1;else if(event.key==='Escape'){$('#agent-report-menu').hidePopover();$('#agent-report-switcher').focus();return;}else return;
    event.preventDefault();options[next]?.focus();
  };
  $('#agent-report-export').onclick=()=>{
    if(!reportValue||!selectedTask)return;
    const url=URL.createObjectURL(new Blob([reportValue.content],{type:'text/markdown;charset=utf-8'})),link=element('a');
    link.href=url;link.download=`saplink-report-${currentReportId??selectedTask.id}.md`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  $('#agent-connection').onchange = async () => {
    if (modelStatus?.active_connection_id) {
      $('#agent-connection').value = modelStatus.active_connection_id;
      return;
    }
    cancelSessionSelection();
    clearUploads(true);
    sessionLoading=false;sessionDetailLoading=false;sessionLoadFailed=false;
    rememberConnection(); const revision=++generation; selectedTask=undefined; taskList=[]; stopStreaming();
    $('#agent-session-search').value='';
    $('#agent-session-search').hidden=true;$('#agent-search-toggle').setAttribute('aria-expanded','false');
    reportTaskId=undefined;reportValue=undefined;reportDrawKey=undefined;chatTaskId=undefined;chatMessages=[];chatCursor=undefined;
    busy=true;renderTask();renderHistory();renderSetup();
    try { await loadSystemSessions(revision); }
    catch(error){if(revision===generation)pollError(error.message);}
    finally {busy=false;updateControls();schedule();}
  };
  function uploadNames(files) { return files?.length ? '附件：' + files.map(file => file.name).join('、') : ''; }
  function messageResources(files,references) {
    return [uploadNames(files),...(references??[]).map(ref=>(ref.kind==='skills'?'技能：':'MCP：')+ref.name)].filter(Boolean).join(' · ');
  }
  function renderUploads() {
    const list = $('#agent-upload-list'); list.replaceChildren();
    pendingUploads.forEach((file, index) => {
      const item = element('div', undefined, 'agent-upload-item');
      const remove = element('button', '×'); remove.type = 'button';
      remove.setAttribute('aria-label', '移除文件 ' + file.name);
      remove.onclick = () => { pendingUploads.splice(index, 1); renderUploads(); updateControls(); };
      const name = element('span', file.name);
      name.title = file.name;
      item.append(name, remove); list.append(item);
    });
    for (const ref of pendingReferences) {
      const item = element('div',undefined,'agent-upload-item');
      const name = element('span',ref.name);
      const label = (ref.kind==='skills'?'技能 ':'MCP ')+ref.name;
      item.title = label;
      const remove = element('button','×'); remove.type = 'button';
      remove.setAttribute('aria-label','移除引用 '+label);
      remove.onclick = () => {
        pendingReferences = pendingReferences.filter(entry=>entry.kind!==ref.kind || entry.id!==ref.id);
        renderUploads(); updateControls();
      };
      item.append(icon(ref.kind==='skills'?'book-open':'server'),name,remove);
      list.append(item);
    }
    for (const site of pendingWebsites) {
      const item = element('div',undefined,'agent-upload-item agent-website-item');
      const label = element('span',undefined,'agent-website-label');
      label.append(element('strong',site.host),element('small',site.pathname==='/'?'':site.pathname));
      const remove = element('button','×'); remove.type = 'button';
      remove.setAttribute('aria-label','移除网站 '+site.host);
      remove.onclick = () => {
        pendingWebsites = pendingWebsites.filter(entry=>entry.href!==site.href);
        renderUploads(); updateControls();
      };
      item.title = site.href;
      item.append(icon('globe'),label,remove); list.append(item);
    }
    const links = pendingWebsites.map(site=>site.href).join('\n');
    $('#agent-prompt').maxLength = links ? Math.max(0,4000-links.length-2) : 4000;
    if (pendingReferences.length || pendingWebsites.length) icons();
  }
  function clearUploads(notify = false) {
    if (notify && (pendingUploads.length || pendingReferences.length || pendingWebsites.length))
      toast('已清除尚未发送的附件、网址和引用。');
    if ($('#agent-add-menu').matches(':popover-open')) $('#agent-add-menu').hidePopover();
    pendingUploads = []; pendingReferences = []; pendingWebsites = []; $('#agent-upload-input').value = ''; renderUploads();
  }
  const addMenu = $('#agent-add-menu'), addButton = $('#agent-upload');
  const referenceSearch = $('#agent-reference-search'), referenceList = $('#agent-reference-list');
  let referenceKind, referenceEntries = [], referenceRequest = 0;
  function showAddOptions() {
    referenceRequest++;
    $('#agent-add-options').hidden = false;
    $('#agent-reference-options').hidden = true;
    if (addMenu.matches(':popover-open')) positionComposerMenu(addButton,addMenu);
  }
  function drawReferenceOptions() {
    const query = referenceSearch.value.trim().toLowerCase();
    const entries = referenceEntries.filter(entry=>[entry.name,entry.description,entry.url].some(value=>value?.toLowerCase().includes(query)));
    referenceList.replaceChildren(...entries.map(entry=>{
      const button = element('button',undefined,'report-option');
      button.type = 'button';
      const description = entry.description || entry.url;
      const title = element('span');
      title.append(element('strong',entry.name));
      if (description) title.append(element('small',description));
      button.append(icon(referenceKind==='skills'?'book-open':'server'),title);
      button.disabled = pendingReferences.some(ref=>ref.kind===referenceKind && ref.id===entry.id);
      button.onclick = () => {
        if (addButton.disabled) return;
        pendingReferences.push({id:entry.id,name:entry.name,kind:referenceKind});
        addMenu.hidePopover();
        renderUploads(); updateControls(); $('#agent-prompt').focus();
      };
      return button;
    }));
    if (!entries.length) referenceList.append(element('p',query?'没有匹配的结果':'没有已启用的项目','context-note'));
    icons();
    if (addMenu.matches(':popover-open')) positionComposerMenu(addButton,addMenu);
  }
  async function openReferenceOptions(kind) {
    const request = ++referenceRequest;
    referenceKind = kind; referenceEntries = [];
    const label = kind==='skills'?'技能':'MCP';
    $('#agent-add-options').hidden = true;
    $('#agent-reference-options').hidden = false;
    $('#agent-reference-back span').textContent = label;
    $('#agent-reference-manage span').textContent = '管理 '+label;
    referenceSearch.value = '';
    referenceSearch.placeholder = '搜索'+label;
    referenceSearch.setAttribute('aria-label','搜索'+label);
    referenceList.replaceChildren(element('p','正在加载…','context-note'));
    positionComposerMenu(addButton,addMenu);
    referenceSearch.focus();
    try {
      const config = await api('agent/extensions');
      if (request!==referenceRequest || !addMenu.matches(':popover-open')) return;
      referenceEntries = config[kind].filter(entry=>entry.enabled);
      drawReferenceOptions();
    } catch (error) {
      if (request===referenceRequest && addMenu.matches(':popover-open'))
        referenceList.replaceChildren(element('p',error.message,'inline-error'));
    }
  }
  addButton.onclick = () => {
    if (addMenu.matches(':popover-open')) { addMenu.hidePopover(); return; }
    showAddOptions(); addMenu.showPopover(); positionComposerMenu(addButton,addMenu);
    $('#agent-add-file').focus();
  };
  addMenu.addEventListener('toggle',()=>{
    const open = addMenu.matches(':popover-open');
    addButton.setAttribute('aria-expanded',String(open));
    if (!open) referenceRequest++;
  });
  $('#agent-add-file').onclick = () => { addMenu.hidePopover(); $('#agent-upload-input').click(); };
  for (const button of addMenu.querySelectorAll('[data-reference-kind]'))
    button.onclick = () => void openReferenceOptions(button.dataset.referenceKind);
  $('#agent-reference-back').onclick = () => { showAddOptions(); $('#agent-add-file').focus(); };
  referenceSearch.oninput = drawReferenceOptions;
  $('#agent-reference-manage').onclick = () => { addMenu.hidePopover(); void openAgentSettings(referenceKind); };
  function queueUploads(files) {
    const combined = [...pendingUploads, ...files];
    if (combined.length > 10 || combined.some(file => file.size > (isImageAttachment(file) ? 32 : 10) * 1024 * 1024) ||
        combined.reduce((total, file) => total + file.size, 0) > 64 * 1024 * 1024) {
      toast('单张图片最多 32 MiB，其他文件单个最多 10 MiB，每次最多 10 个、合计 64 MiB。', true); return;
    }
    if (files.some(file => file.name.length > 200)) {
      toast('文件名过长，请重命名后重试。', true); return;
    }
    pendingUploads = combined; renderUploads(); updateControls();
  }
  function isImageAttachment(file) {
    return /\.(png|jpe?g|gif|webp)$/i.test(file.name) || /^image\/(png|jpeg|gif|webp)$/i.test(file.type ?? '');
  }
  $('#agent-upload-input').onchange = event => {
    const files = [...event.target.files]; event.target.value = '';
    queueUploads(files);
  };
  $('#agent-prompt').onpaste = event => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const fileItems = [...clipboard.items].filter(item => item.kind === 'file');
    const files = [...clipboard.files];
    if (fileItems.length > files.length) {
      files.length = 0;
      for (const item of fileItems) {
        const file = item.getAsFile();
        if (!file) {
          event.preventDefault();
          toast('无法读取剪贴板中的文件，请使用“添加文件”选择。', true);
          return;
        }
        files.push(file);
      }
    }
    if (!files.length && !fileItems.length && ![...clipboard.types].includes('Files')) {
      const value = clipboard.getData?.('text/plain')?.trim() ?? '';
      const site = /^(?:https?:\/\/|www\.)\S+$/i.test(value)
        ? URL.parse(/^www\./i.test(value)?'https://'+value:value) : null;
      const prompt = event.target;
      if (!site || site.username || site.password || site.href.length>2048 || !prompt ||
          prompt.selectionStart!==prompt.value.length || prompt.selectionEnd!==prompt.value.length || $('#agent-upload').disabled) return;
      event.preventDefault();
      if (pendingWebsites.some(entry=>entry.href===site.href)) return;
      const links = [...pendingWebsites,site].map(entry=>entry.href).join('\n');
      if (pendingWebsites.length>=5 || links.length+(prompt.value ? prompt.value.length+2 : 0)>4000) {
        toast('每条消息最多添加 5 个网址，正文和网址合计最多 4000 字。',true);
        return;
      }
      pendingWebsites.push(site);
      renderUploads(); updateControls();
      return;
    }
    event.preventDefault();
    if ($('#agent-upload').disabled) {
      toast('当前无法添加文件，请稍后重试。', true);
    } else if (files.length) {
      queueUploads(files);
    } else {
      toast('无法读取剪贴板中的文件，请使用“添加文件”选择。', true);
    }
  };
  $('#agent-prompt').oninput = updateControls;
  $('#agent-prompt').onkeydown = event => {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey ||
      event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat && !$('#agent-send').disabled) $('#agent-send').click();
  };
  for (const button of document.querySelectorAll('[data-agent-prompt]')) button.onclick = () => {
    $('#agent-prompt').value = button.dataset.agentPrompt; $('#agent-prompt').focus(); updateControls();
  };
  $('#agent-new').onclick = () => {
    cancelSessionSelection();
    clearUploads(true);
    generation++; sessionLoading=false;sessionDetailLoading=false;sessionLoadFailed=false;
    selectedTask = undefined; $('#agent-prompt').value = '';
    reportLoading=false;pollError('');
    rememberTask();
    renderTask(); renderHistory(); renderSetup();
  };
  async function selectSession(id) {
    const summary = taskList.find(task => task.id === id && task.connection_id === $('#agent-connection').value);
    if (!summary) { pollError('会话不存在或不属于当前系统，请刷新后重试。'); return; }
    if (selectedTask?.id !== id) clearUploads(true);
    const revision = ++generation;
    sessionLoading=true;sessionDetailLoading=true;sessionLoadFailed=false;
    selectedTask=summary;stopStreaming();rememberTask();pollError('');
    reportTaskId=undefined;currentReportId=undefined;reportValue=undefined;reportDrawKey=undefined;reportLoading=true;reportRequest++;
    chatTaskId=undefined;chatMessages=[];chatCursor=undefined;
    for (const row of document.querySelectorAll('#agent-session-list .session-item')) {
      const selected=row.dataset.taskId===id;
      row.classList.toggle('selected',selected);
      row.querySelector('.session-select')?.setAttribute('aria-pressed',String(selected));
    }
    renderTask();renderHistory();renderSetup();
    try {
      const task = await api(`agent/tasks/${id}`);
      if (revision !== generation) return;
      if(task.connection_id!==$('#agent-connection').value)throw new Error('该会话属于其他系统。');
      selectedTask = task;sessionDetailLoading=false;
      rememberTask();
      renderTask(); renderHistory(); renderSetup();
      await Promise.all([loadConversation(),loadReport()]);
    } catch (error) {
      if (revision === generation) {
        sessionDetailLoading=false;sessionLoadFailed=true;reportLoading=false;
        renderTask();renderSetup();pollError('对话暂时无法加载。'+error.message);
      }
    } finally { if (revision === generation) { sessionLoading=false;updateControls();schedule(); } }
  }
  $('#agent-history').onchange = () => {
    const id = $('#agent-history').value;
    if (!id) { $('#agent-new').click(); return; }
    void selectSession(id);
  };
  async function submitTask(resume = false) {
    if (busy || $('#agent-send').disabled) return;
    if (selectedTask && !terminal(selectedTask)) {
      const input = $('#agent-prompt'), prompt = input.value.trim();
      if (!prompt) return;
      busy=true;generation++;updateControls();
      try {
        await api(`agent/tasks/${selectedTask.id}/steer`,'POST',{prompt});
        input.value='';pollError('');toast('已发送补充说明');
      } catch(error) { pollError(error.message); }
      finally { busy=false;updateControls();input.focus();schedule(); }
      return;
    }
    const prompt = [$('#agent-prompt').value.trim(),pendingWebsites.map(site=>site.href).join('\n')].filter(Boolean).join('\n\n');
    const connectionId = $('#agent-connection').value;
    if (!resume && (!prompt || !connectionId)) return;
    busy = true; generation++; updateControls();
    try {
      const attachments = [];
      if (!resume) {
        for (const file of pendingUploads) {
          const bytes = await file.arrayBuffer();
          if (isImageAttachment(file) || /\.(pdf|docx?|xlsx?|pptx?)$/i.test(file.name) ||
              /^(image\/|application\/pdf$|application\/vnd\.openxmlformats-officedocument\.)/i.test(file.type)) {
            const data = new Uint8Array(bytes);
            let binary = '';
            for (let i = 0; i < data.length; i += 16384)
              binary += String.fromCharCode(...data.subarray(i,i+16384));
            attachments.push({name:file.name,content:btoa(binary),encoding:'base64'});
            continue;
          }
          let content;
          try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
          catch { throw new Error('文件“' + file.name + '”不是有效的 UTF-8 文本。'); }
          if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content))
            throw new Error('文件“' + file.name + '”不是受支持的文本文件。');
          attachments.push({ name: file.name, content });
        }
      }
      const path = resume ? `agent/tasks/${selectedTask.id}/resume`
        : selectedTask ? `agent/tasks/${selectedTask.id}/messages` : 'agent/tasks';
      const output_mode='chat', write_mode=chosenWriteMode();
      const selectedReport=reportTaskId===selectedTask?.id?$('#agent-report-history').value:undefined;
      const input = resume ? {} : selectedTask ? { prompt, output_mode,write_mode,...(selectedReport?{selected_report_id:selectedReport}:{}),attachments } : { prompt, connection_id: connectionId, output_mode, write_mode, attachments };
      if (!resume && pendingReferences.length) input.references = {
        skills:pendingReferences.filter(ref=>ref.kind==='skills').map(ref=>ref.id),
        mcp:pendingReferences.filter(ref=>ref.kind==='mcp').map(ref=>ref.id)
      };
      selectedTask = await api(path, 'POST', input);
      rememberTask();
      if (!resume) { $('#agent-prompt').value = ''; clearUploads(); }
      const existing = taskList.findIndex(task => task.id === selectedTask.id);
      if (existing >= 0) taskList[existing] = selectedTask; else taskList.unshift(selectedTask);
      modelStatus.active_task_ids = [...new Set([...(modelStatus.active_task_ids ?? []),selectedTask.id])];
      modelStatus.active_task_id = modelStatus.active_task_ids[0];
      modelStatus.active_connection_id = selectedTask.connection_id;
      renderHistory(); renderTask(); renderSetup(); pollError('');
      await Promise.all([loadConversation(),loadReport()]);
    } catch (error) { pollError(error.message); }
    finally { busy = false; updateControls(); schedule(); }
  }
  $('#agent-prompt-form').onsubmit = event => {
    event.preventDefault();
    void submitTask($('#agent-send').dataset.action==='resume');
  };
  $('#agent-stop').onclick = async () => {
    if (!selectedTask || busy) return;
    busy = true; generation++; updateControls();
    try {
      selectedTask = await api(`agent/tasks/${selectedTask.id}/stop`, 'POST', {});
      taskList = taskList.map(task=>task.id===selectedTask.id?selectedTask:task);
      renderHistory();
      renderTask();
      modelStatus = await api('agent/status');
      renderSetup();
    } catch (error) { pollError(error.message); }
    finally { busy = false; updateControls(); schedule(); }
  };
  $('#agent-retry-poll').onclick = () => sessionLoadFailed && selectedTask ? void selectSession(selectedTask.id) : void load();
  function forgetDeleted(ids) {
    for(const id of ids){rememberReport(id,undefined);reportHeads.delete(id);for(const key of reportTabs.keys())if(key.startsWith(id+':'))reportTabs.delete(key);}
    if(ids.includes(reportTaskId)){reportTaskId=undefined;reportValue=undefined;reportDrawKey=undefined;}
    if(ids.includes(chatTaskId)){chatTaskId=undefined;chatMessages=[];chatCursor=undefined;}
    if(selectedTask && ids.includes(selectedTask.id)) {
      generation++;selectedTask=undefined;rememberTask();stopStreaming();chatTaskId=undefined;chatMessages=[];chatCursor=undefined;
    }
    taskList=taskList.filter(task=>!ids.includes(task.id));renderHistory();renderTask();
  }
  async function previewCleanup() {
    const revision=++manageRevision;cleanupCandidates=[];$('#agent-manage-confirm').disabled=true;
    $('#agent-cleanup-list').replaceChildren();$('#agent-manage-error').textContent='';
    try {
      const result=await api('agent/tasks/cleanup/preview','POST',{older_than_days:Number($('#agent-cleanup-days').value),
        keep_ids:$('#agent-keep-current').checked&&selectedTask?[selectedTask.id]:[],connection_id:$('#agent-connection').value||undefined});
      if(revision!==manageRevision||!$('#agent-manage-dialog').open)return;
      cleanupCandidates=result.candidates;
      for(const task of cleanupCandidates) $('#agent-cleanup-list').append(element('li',task.title));
      $('#agent-manage-description').textContent=cleanupCandidates.length
        ? `将删除以下 ${cleanupCandidates.length} 个会话及其问答、源码附件和执行轨迹，无法撤销。运行中及置顶会话会保留。`
        : '没有符合条件的会话。运行中及置顶会话会保留。';
      $('#agent-manage-confirm').textContent=`清理 ${cleanupCandidates.length} 个会话`;
      $('#agent-manage-confirm').disabled=!cleanupCandidates.length;
    }catch(error){if(revision===manageRevision)$('#agent-manage-error').textContent=error.message;}
  }
  function openManage(mode, task=selectedTask, report) {
    cancelSessionSelection();
    manageMode=mode;managedTask=task?{...task}:undefined;managedReport=report?{...report}:undefined;manageRevision++;
    const reportMode=mode.startsWith('report-'),rename=mode==='rename'||mode==='report-rename',remove=mode==='delete'||mode==='report-delete';
    $('#agent-manage-heading').textContent=reportMode?(rename?'重命名报告':'删除报告'):rename?'重命名会话':remove?'删除会话':'清理历史会话';
    $('#agent-title-caption').textContent=reportMode?'报告名称':'会话名称';
    $('#agent-title-label').hidden=!rename;$('#agent-title').required=rename;
    $('#agent-title').value=reportMode?report.title:task?.title??task?.prompt.slice(0,80)??'';
    $('#agent-cleanup-options').hidden=mode!=='cleanup';$('#agent-cleanup-list').replaceChildren();
    $('#agent-manage-error').textContent='';$('#agent-manage-confirm').disabled=false;
    $('#agent-manage-confirm').textContent=remove?(reportMode?'删除报告':'删除会话'):'保存名称';
    $('#agent-manage-description').textContent=mode==='report-delete'?`将移除报告“${report.title}”，会话和对话历史会保留。此操作无法撤销。`:mode==='delete'
      ? `将删除“${task?.title??task?.prompt.slice(0,80)}”及其问答、源码附件和执行轨迹，无法撤销。` : '';
    $('#agent-manage-dialog').showModal();
    if(rename)$('#agent-title').focus();
    if(mode==='cleanup'){$('#agent-keep-current').checked=true;$('#agent-keep-current').disabled=!selectedTask;void previewCleanup();}
  }
  $('#agent-cleanup').onclick=()=>openManage('cleanup');
  $('#agent-cleanup-days').onchange=()=>void previewCleanup();$('#agent-keep-current').onchange=()=>void previewCleanup();
  $('#agent-manage-cancel').onclick=()=>$('#agent-manage-dialog').close();
  $('#agent-manage-dialog').addEventListener('close',()=>{manageRevision++;});
  $('#agent-manage-form').onsubmit=async event=>{
    event.preventDefault();if(busy)return;busy=true;updateControls();$('#agent-manage-confirm').disabled=true;
    try {
      if(manageMode==='report-rename'||manageMode==='report-delete'){
        const remove=manageMode==='report-delete';
        const body={updated_at:managedReport.updated_at,artifact_id:managedReport.artifact_id,...(remove?{confirm:true}:{title:$('#agent-title').value.trim()})};
        const result=await api(`agent/tasks/${managedTask.id}/reports/${encodeURIComponent(managedReport.id)}`,remove?'DELETE':'PATCH',body);
        reportHeads.set(managedTask.id,result.active_report_id);
        if(remove&&currentReportId===managedReport.id){rememberReport(managedTask.id,undefined);reportValue=undefined;reportDrawKey=undefined;reportTabs.delete(managedTask.id+':'+managedReport.id);}
        toast(remove?'报告已删除':'报告已重命名');
      }
      else if(manageMode==='rename') {
        const updated=await api(`agent/tasks/${managedTask.id}`,'PATCH',{title:$('#agent-title').value.trim()});
        if(selectedTask?.id===updated.id)selectedTask=updated;
      }
      else if(manageMode==='delete') {
        const result=await api(`agent/tasks/${managedTask.id}`,'DELETE',{confirm:true,updated_at:managedTask.updated_at});
        forgetDeleted([managedTask.id]);toast(result.cleanup_pending?'会话已移除，部分附件将在下次启动时继续清理。':'会话已删除');
      } else {
        const result=await api('agent/tasks/cleanup','POST',{confirm:true,items:cleanupCandidates.map(task=>({id:task.id,updated_at:task.updated_at}))});
        forgetDeleted(result.deleted.map(task=>task.id));
        toast(`已移除 ${result.deleted.length} 个会话，保留 ${result.skipped.length} 个发生变化的会话。`+
          (result.deleted.some(task=>task.cleanup_pending)?'部分附件将在下次启动时继续清理。':''));
      }
      $('#agent-manage-dialog').close();busy=false;await load();
    } catch(error){$('#agent-manage-error').textContent=error.message;}
    finally{busy=false;$('#agent-manage-confirm').disabled=false;updateControls();}
  };
  const settingsDialog = $('#agent-model-dialog');
  const settingsTabs = [...$('#agent-settings-tabs').querySelectorAll('button')];
  const modelForm = $('#agent-model-form');
  const extensionsPanel = $('#agent-extensions-panel');
  const skillPanel = $('#agent-skills-panel');
  const mcpPanel = $('#agent-mcp-panel'), mcpLibrary = $('#agent-mcp-library');
  const mcpForm = $('#agent-mcp-form');
  const mcpFields = mcpForm.elements;
  const skillEndpoint = 'agent/extensions/skills/';
  const mcpEndpoint = 'agent/extensions/mcp/';
  let extensionsConfig, extensionsBusy = false, editingMcpId;
  const extensionResult = $('#agent-extensions-result');
  const extensionError = $('#agent-extensions-error');
  function extensionRow(entry,subtitle,glyph,open,toggleEnabled) {
    const row = element('li',undefined,'agent-extension-row');
    const name = element('button',undefined,'agent-extension-name');
    const badge = element('span',undefined,'agent-extension-icon');
    badge.setAttribute('aria-hidden','true');
    badge.append(icon(glyph));
    const summary = element('span');
    summary.append(element('strong',entry.name),element('small',subtitle));
    const arrow = element('span',undefined,'agent-extension-arrow');
    arrow.setAttribute('aria-hidden','true');
    arrow.append(icon('chevron-right'));
    name.append(badge,summary,arrow);
    name.type = 'button';
    name.onclick = open;
    if (entry.builtin) {
      row.append(name,element('span','始终启用','agent-extension-fixed'));
      return row;
    }
    const toggle = element('button',undefined,'agent-extension-toggle');
    toggle.type = 'button';
    toggle.setAttribute('role','switch');
    toggle.setAttribute('aria-label',entry.name);
    toggle.setAttribute('aria-checked',String(entry.enabled));
    toggle.onclick = toggleEnabled;
    row.append(name,toggle);
    return row;
  }
  function drawMcp() {
    const services = extensionsConfig.mcp;
    $('#agent-mcp-empty').hidden = services.length>0;
    $('#agent-mcp-list').replaceChildren(...services.map(entry=>extensionRow(entry,entry.url,'server',()=>openMcpEditor(entry),
      ()=>void runExtensionAction(async()=>{
        extensionsConfig = await api(mcpEndpoint+entry.id,'PATCH',{enabled:!entry.enabled});
        drawMcp();
        extensionResult.textContent = entry.enabled?'已停用。':'已启用，下次发送时生效。';
      }))));
    icons();
  }
  function openMcpEditor(entry) {
    editingMcpId = entry?.id;
    mcpForm.reset();
    $('#agent-mcp-editor-heading').textContent = entry ? '编辑 MCP 服务' : '添加 MCP 服务';
    mcpFields.label.value = entry?.name ?? '';
    mcpFields.url.value = entry?.url ?? '';
    mcpFields.token.placeholder = entry?.has_token ? '已保存，留空保留' : '选填';
    mcpFields.remove.hidden = !entry;
    mcpFields.test.hidden = !entry;
    mcpLibrary.hidden = true;
    mcpForm.hidden = false;
    extensionResult.textContent = ''; extensionError.textContent = '';
    mcpFields.label.focus();
  }
  function closeMcpEditor() {
    editingMcpId = undefined;
    mcpFields.token.value = '';
    mcpForm.hidden = true;
    mcpLibrary.hidden = false;
  }
  async function runExtensionAction(action) {
    if (extensionsBusy) return;
    extensionsBusy = true;
    extensionsPanel.inert = true;
    settingsDialog.setAttribute('aria-busy','true');
    extensionResult.textContent = ''; extensionError.textContent = '';
    try { await action(); }
    catch (error) { extensionError.textContent = error.message; }
    finally { extensionsBusy = false; extensionsPanel.inert = false; settingsDialog.removeAttribute('aria-busy'); }
  }
  function showSettingsSection(section) {
    if(skillAddMenu.matches(':popover-open'))skillAddMenu.hidePopover();
    for (const tab of settingsTabs) tab.setAttribute('aria-pressed',String(tab.dataset.section===section));
    modelForm.hidden = section!=='key';
    extensionsPanel.hidden = section==='key';
    skillPanel.hidden = !extensionsConfig || section!=='skills';
    mcpPanel.hidden = !extensionsConfig || section!=='mcp';
    extensionResult.textContent = ''; extensionError.textContent = '';
  }
  for (const tab of settingsTabs) tab.onclick = async () => {
    if (extensionsBusy || $('#agent-model-save').disabled) return;
    const section = tab.dataset.section;
    showSettingsSection(section);
    if (section==='key' || extensionsConfig) return;
    await runExtensionAction(async()=>{
      extensionsConfig = await api('agent/extensions');
      drawSkills();
      drawMcp();
      showSettingsSection(section);
    });
  };
  $('#agent-mcp-add').onclick = () => openMcpEditor();
  $('#agent-mcp-back').onclick = () => {
    closeMcpEditor();
    extensionResult.textContent=''; extensionError.textContent='';
    $('#agent-mcp-add').focus();
  };
  mcpForm.onsubmit = event=>{
    event.preventDefault();
    void runExtensionAction(async()=>{
      const id = editingMcpId || crypto.randomUUID();
      const input = {name:mcpFields.label.value,url:mcpFields.url.value,token:mcpFields.token.value};
      mcpFields.token.value='';
      extensionsConfig = await api(mcpEndpoint+id,'PUT',input);
      closeMcpEditor();
      drawMcp();
      extensionResult.textContent='已保存，下次发送时生效。';
    });
  };
  mcpFields.remove.onclick = () => {
    const entry = extensionsConfig.mcp.find(service=>service.id===editingMcpId);
    if (!entry) return;
    confirmAction('删除 MCP 服务','删除「'+entry.name+'」？',()=>runExtensionAction(async()=>{
      extensionsConfig = await api(mcpEndpoint+entry.id,'DELETE');
      closeMcpEditor();
      drawMcp();
      extensionResult.textContent='已删除。';
    }));
  };
  mcpFields.test.onclick = () => void runExtensionAction(async()=>{
    const id = editingMcpId;
    if (!id) return;
    const button = mcpFields.test;
    button.setAttribute('aria-busy','true');
    button.setAttribute('aria-label','正在测试连接');
    button.title='正在测试连接';
    try {
      const tools = await api(mcpEndpoint+id+'/test','POST',{});
      extensionResult.textContent = tools.length
        ? '连接成功，可用工具：'+tools.map(tool=>tool.name).join('、') : '连接成功，服务未提供可用的只读工具。';
    } finally {
      button.removeAttribute('aria-busy');
      button.setAttribute('aria-label','测试连接');
      button.title='测试连接';
    }
  });
  const skillActions = $('#agent-skill-actions'), skillDrop = $('#agent-skill-drop'), skillFileInput = $('#agent-skill-file');
  const skillList = $('#agent-skill-list'), skillDetail = $('#agent-skill-detail'), skillBuilder = $('#agent-skill-builder');
  const skillFiles = $('#agent-skill-files'), skillPreview = $('#agent-skill-preview');
  const skillChat = $('#agent-skill-chat'), skillPrompt = $('#agent-skill-prompt'), skillDraftFiles = $('#agent-skill-draft-files');
  let selectedSkill, skillOffset, replacingSkill, skillPreviewRequest = 0, skillMessages = [], skillDraft;
  function setSkillDetail(id) {
    selectedSkill = id;
    skillOffset = undefined;
    skillPreviewRequest++;
    skillDetail.removeAttribute('aria-busy');
    if(id && !skillDetail.open)skillDetail.showModal();
    if(!id && skillDetail.open)skillDetail.close();
  }
  $('#agent-skill-detail-close').onclick=()=>skillDetail.close();
  skillDetail.addEventListener('close',()=>{
    if(skillDetail.open)return;
    const id=selectedSkill;
    setSkillDetail();
    if(id&&settingsDialog.open&&!skillPanel.hidden)
      skillList.querySelector(`[data-skill-id="${CSS.escape(id)}"]`)?.focus();
  });
  function openSkillDetail(skill) {
    $('#agent-skill-title').textContent = skill.name;
    skillFiles.replaceChildren(...(skill.files ?? ['SKILL.md']).map(path=>new Option(path)));
    skillFiles.value = 'SKILL.md';
    setSkillDetail(skill.id);
    void previewSkillFile(0);
  }
  function addSkillMenu(row,skill) {
    row.classList.add('agent-skill-manageable');
    const trigger = element('button',undefined,'agent-skill-menu-trigger');
    trigger.type = 'button';
    trigger.setAttribute('aria-label','管理技能 '+skill.name);
    trigger.setAttribute('aria-expanded','false');
    trigger.append(icon('ellipsis'));
    const menu = element('div',undefined,'agent-skill-menu');
    menu.id = 'agent-skill-menu-'+skill.id;
    menu.setAttribute('popover','auto');
    trigger.setAttribute('aria-controls',menu.id);
    menu.setAttribute('role','group');
    menu.setAttribute('aria-label','技能操作');
    const upload = element('button'), remove = element('button',undefined,'agent-skill-menu-remove');
    upload.type = remove.type = 'button';
    upload.append(icon('upload'),element('span','重新上传技能'));
    remove.append(icon('trash-2'),element('span','卸载技能'));
    upload.onclick = () => { menu.hidePopover(); chooseSkillZip(skill.id); };
    remove.onclick = () => { menu.hidePopover(); uninstallSkill(skill); };
    menu.append(upload,remove);
    trigger.onclick = () => {
      if (menu.matches(':popover-open')) { menu.hidePopover(); return; }
      menu.showPopover({source:trigger});
      const anchor = trigger.getBoundingClientRect(), bounds = menu.getBoundingClientRect();
      menu.style.left = Math.max(8,anchor.right-bounds.width)+'px';
      menu.style.top = (anchor.bottom+bounds.height+12<window.innerHeight ? anchor.bottom+4 : Math.max(8,anchor.top-bounds.height-4))+'px';
    };
    menu.addEventListener('toggle',()=>trigger.setAttribute('aria-expanded',String(menu.matches(':popover-open'))));
    row.append(trigger,menu);
  }
  function drawSkills() {
    const skills = extensionsConfig.skills;
    skillDrop.hidden = !skillBuilder.hidden;
    $('#agent-skill-empty').hidden = skills.length>0;
    skillActions.hidden = !skillBuilder.hidden;
    skillList.replaceChildren(...skills.map(skill=>{
      const description = skill.description || `${skill.files?.length ?? 1} 个文件`;
      const row = extensionRow(skill,skill.builtin?'内置 · '+description:description,'book-open',()=>openSkillDetail(skill),()=>void runExtensionAction(async()=>{
        extensionsConfig = await api(skillEndpoint+skill.id,'PATCH',{enabled:!skill.enabled});
        drawSkills();
        extensionResult.textContent = skill.enabled?'已停用。':'已启用，下次发送时生效。';
      }));
      const button = row.querySelector('.agent-extension-name');
      button.dataset.skillId = skill.id;
      button.setAttribute('aria-controls','agent-skill-detail');
      button.setAttribute('aria-haspopup','dialog');
      if (!skill.builtin) addSkillMenu(row,skill);
      return row;
    }));
    icons();
  }
  async function previewSkillFile(offset) {
    const request = ++skillPreviewRequest;
    const errorText = $('#agent-skill-preview-error');
    errorText.textContent = '';
    if (!offset) {
      skillPreview.textContent = '正在读取…';
      skillOffset = undefined;
      skillPreview.scrollTop = 0;
    }
    skillDetail.setAttribute('aria-busy','true');
    try {
      const file = await api(skillEndpoint+selectedSkill+'/file?'+new URLSearchParams({path:skillFiles.value,offset}));
      if (request!==skillPreviewRequest || !skillDetail.open) return;
      const text = file.binary ? '二进制文件已保存在技能包内。' : file.text;
      if (offset) skillPreview.append(document.createTextNode(text));
      else skillPreview.textContent = text;
      skillOffset = file.next_offset;
    } catch (error) {
      if (request!==skillPreviewRequest || !skillDetail.open) return;
      if (!offset) skillPreview.textContent = '';
      skillOffset = undefined;
      errorText.textContent = error.message;
    } finally {
      if (request===skillPreviewRequest) {
        skillDetail.removeAttribute('aria-busy');
        if (skillPreview.scrollHeight<=skillPreview.clientHeight) readMoreSkillPreview();
      }
    }
  }
  skillFiles.onchange = () => void previewSkillFile(0);
  function readMoreSkillPreview() {
    if (skillDetail.open && skillOffset!=null && !skillDetail.hasAttribute('aria-busy') &&
      skillPreview.scrollHeight-skillPreview.scrollTop-skillPreview.clientHeight<=32) void previewSkillFile(skillOffset);
  }
  skillPreview.addEventListener('scroll',readMoreSkillPreview);
  function uninstallSkill(skill) {
    confirmAction('卸载技能','卸载「'+skill.name+'」及其文件？',()=>runExtensionAction(async()=>{
      extensionsConfig = await api(skillEndpoint+skill.id,'DELETE');
      if (selectedSkill===skill.id) setSkillDetail();
      drawSkills();
      extensionResult.textContent = '已卸载。';
    }));
  }
  function fileBase64(file) {
    return new Promise((resolve,reject)=>{
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('无法读取所选文件。'));
      reader.readAsDataURL(file);
    });
  }
  const ignoredSkillPaths = new Set(['.git','__macosx','.ds_store','thumbs.db']);
  function checkSkillSize(count,size) {
    if (count>128 || size>8*1024*1024) throw new Error('技能包最多 8 MiB、128 个文件。');
  }
  async function installLocalSkill(payload) {
    extensionsConfig = await api(skillEndpoint+'import','POST',payload);
    drawSkills();
    extensionResult.textContent = '技能已安装，可在列表中启用。';
  }
  async function importSkillFolder(files) {
    if (!files.length) throw new Error('技能文件夹为空，或没有可导入的文件。');
    checkSkillSize(files.length,files.reduce((size,{file})=>size+file.size,0));
    await installLocalSkill({format:'folder',files:await Promise.all(files.map(async ({file,path})=>({path,data:await fileBase64(file)})))});
  }
  async function importSkillZip(file,replaceId) {
    if (!/\.zip$/i.test(file.name)) throw new Error('请选择 ZIP 技能包，或将技能文件夹拖到列表区。');
    checkSkillSize(1,file.size);
    const payload = {format:'zip',data:await fileBase64(file)};
    if (!replaceId) return installLocalSkill(payload);
    extensionsConfig = await api(skillEndpoint+replaceId+'/package','PUT',payload);
    drawSkills();
    openSkillDetail(extensionsConfig.skills.find(entry=>entry.id===replaceId));
    extensionResult.textContent = '技能已更新。';
  }
  function chooseSkillZip(replaceId) {
    replacingSkill = replaceId;
    skillFileInput.click();
  }
  skillAddButton.onclick=()=>{
    if(skillAddMenu.matches(':popover-open')){skillAddMenu.hidePopover();return;}
    skillAddMenu.showPopover();
    positionComposerMenu(skillAddButton,skillAddMenu);
    $('#agent-skill-import').focus();
  };
  $('#agent-skill-import').onclick = () => {
    skillAddMenu.hidePopover();
    skillAddButton.focus();
    chooseSkillZip();
  };
  skillFileInput.onchange = () => {
    const file = skillFileInput.files[0];
    const replaceId = replacingSkill;
    replacingSkill = undefined;
    skillFileInput.value = '';
    if (file) void runExtensionAction(()=>importSkillZip(file,replaceId));
  };
  async function droppedSkillFiles(root) {
    const files = [];
    let size = 0, visited = 0;
    async function read(entry,path) {
      if (ignoredSkillPaths.has(entry.name.toLowerCase())) return;
      if (++visited>4096 || path.length>240) throw new Error('技能包目录项过多或文件路径过长。');
      if (entry.isFile) {
        const file = await new Promise((resolve,reject)=>entry.file(resolve,reject));
        checkSkillSize(files.length+1,size+=file.size);
        files.push({file,path});
        return;
      }
      const reader = entry.createReader();
      while (true) {
        const batch = await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));
        if (!batch.length) break;
        for (const child of batch) await read(child,path+'/'+child.name);
      }
    }
    await read(root,root.name);
    return files;
  }
  settingsDialog.addEventListener('dragover',event=>{
    if (!skillDrop.hidden && !skillPanel.hidden && event.dataTransfer.types.includes('Files')) {
      event.preventDefault();
      const accepts = !extensionsBusy && skillDrop.contains(event.target);
      event.dataTransfer.dropEffect = accepts?'copy':'none';
      skillDrop.toggleAttribute('data-dragging',accepts);
    }
  });
  skillDrop.ondragleave = event=>{
    if (!skillDrop.contains(event.relatedTarget)) skillDrop.removeAttribute('data-dragging');
  };
  settingsDialog.addEventListener('drop',event=>{
    skillDrop.removeAttribute('data-dragging');
    if (skillDrop.hidden || skillPanel.hidden || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    if (extensionsBusy || !skillDrop.contains(event.target)) return;
    const items = [...event.dataTransfer.items].filter(item=>item.kind==='file');
    const files = [...event.dataTransfer.files];
    const entry = items[0]?.webkitGetAsEntry?.();
    void runExtensionAction(async()=>{
      if ((items.length || files.length)!==1) throw new Error('请一次拖入一个技能文件夹或 ZIP。');
      if (entry?.isDirectory) return importSkillFolder(await droppedSkillFiles(entry));
      const file = files[0];
      if (!file) throw new Error('无法读取拖入的技能，请使用「本地导入技能」。');
      await importSkillZip(file);
    });
  });
  function showSkillBuilder(show) {
    setSkillDetail();
    skillBuilder.hidden = !show;
    drawSkills();
    if (show) skillPrompt.focus();
  }
  $('#agent-skill-create').onclick = () => {
    skillAddMenu.hidePopover();
    showSkillBuilder(true);
  };
  $('#agent-skill-close-builder').onclick = () => showSkillBuilder(false);
  function resetSkillBuilder() {
    skillMessages = [];
    skillDraft = undefined;
    skillPrompt.value = '';
    skillChat.replaceChildren();
    $('#agent-skill-draft').hidden = true;
    skillBuilder.hidden = true;
    setSkillDetail();
  }
  skillDraftFiles.onchange = () => {
    $('#agent-skill-draft-preview').textContent = skillDraft.files[Number(skillDraftFiles.value)].text;
  };
  $('#agent-skill-chat-form').onsubmit = event=>{
    event.preventDefault();
    const content = skillPrompt.value.trim();
    if (!content) return;
    void runExtensionAction(async()=>{
      const messages = [...skillMessages.slice(-22),{role:'user',content}];
      extensionResult.textContent = '正在生成…';
      try {
        const result = await api(skillEndpoint+'chat','POST',{messages,draft:skillDraft});
        skillMessages = [...messages,{role:'assistant',content:result.reply}];
        skillPrompt.value = '';
        skillChat.append(element('p',content,'agent-skill-user'),element('p',result.reply,'agent-skill-assistant'));
        skillChat.scrollTop = skillChat.scrollHeight;
        if (result.draft) {
          skillDraft = result.draft;
          $('#agent-skill-draft-name').textContent = result.name+' · 技能草稿';
          skillDraftFiles.replaceChildren(...skillDraft.files.map((file,index)=>new Option(file.path,String(index))));
          skillDraftFiles.value = String(Math.max(0,skillDraft.files.findIndex(file=>file.path.toLowerCase()==='skill.md')));
          skillDraftFiles.onchange();
          $('#agent-skill-draft').hidden = false;
        }
      } finally { extensionResult.textContent = ''; }
    });
  };
  $('#agent-skill-install').onclick = () => void runExtensionAction(async()=>{
    if (!skillDraft) return;
    extensionsConfig = await api(skillEndpoint+'install','POST',skillDraft);
    resetSkillBuilder();
    drawSkills();
    extensionResult.textContent = '技能已安装，可在列表中启用。';
  });
  async function openAgentSettings(section='key') {
    if (settingsDialog.open) return;
    $('#agent-api-key').value = ''; $('#agent-model-error').textContent = '';
    try {
      const current = await api('agent/model');
      const savedKey = current.configured && current.key_source === 'windows_credentials';
      const configuredKey = current.configured;
      $('#agent-key-indicator').hidden = !configuredKey;
      $('#agent-key-indicator').textContent = savedKey ? '已保存' : '已配置';
      $('#agent-api-key').placeholder = savedKey ? '••••••••（已保存，留空保留）'
        : configuredKey ? '管理员已配置；仅替换时填写'
          : current.key_source === 'unavailable' ? '密钥无法读取，请重新输入' : '输入你的 DeepSeek API Key';
      extensionsConfig = undefined;
      showSettingsSection('key');
      settingsDialog.showModal();
      if (section!=='key') settingsTabs.find(tab=>tab.dataset.section===section)?.click();
      else if (!configuredKey) $('#agent-api-key').focus();
    } catch (error) { pollError(error.message); }
  }
  $('#agent-settings').onclick = () => void openAgentSettings();
  $('#agent-configure-model').onclick = () => void openAgentSettings();
  $('#agent-model-close').onclick = () => { if(!extensionsBusy)settingsDialog.close(); };
  settingsDialog.addEventListener('cancel',event=>{if(extensionsBusy)event.preventDefault();});
  settingsDialog.addEventListener('close',()=>{
    if(skillAddMenu.matches(':popover-open'))skillAddMenu.hidePopover();
    $('#agent-api-key').value = '';
    closeMcpEditor();
    skillBuilder.hidden = true;
    setSkillDetail();
    skillDrop.removeAttribute('data-dragging');
  });
  modelForm.onsubmit = async event => {
    event.preventDefault();
    const key = $('#agent-api-key').value.trim(); $('#agent-api-key').value = '';
    $('#agent-model-save').disabled = true; $('#agent-model-error').textContent = '';
    try {
      const current = await api('agent/model');
      const saved = await api('agent/model', 'PUT', { model: current.model,
        ...(key ? { api_key: key } : {}) });
      if (!saved.configured) throw new Error('设置已写入，但无法读取密钥，请检查 Windows 凭据管理器后重试。');
      settingsDialog.close();
      toast(saved.credential_cleanup_warning ? '新设置已保存，旧密钥清理未确认，请联系管理员处理。' : '模型设置已保存');
      await load();
    } catch (error) { $('#agent-model-error').textContent = error.message; }
    finally { $('#agent-model-save').disabled = false; }
  };
  document.addEventListener('visibilitychange', () => { if(document.hidden)pauseStreaming();else if(!view.hidden)void poll(); });
  new MutationObserver(()=>{if(view.hidden)pauseStreaming();}).observe(view,{attributes:true,attributeFilter:['hidden']});
  updateControls(); icons();
  if (!initialPage.has('view') || initialPage.get('view') === 'agent') { showView('agent'); void load(); }
  else showView('connections');
})();
