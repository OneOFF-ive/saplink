/* Present actual execution events, never model reasoning or invented progress. */
(() => {
  function build(task,now=Date.now()) {
    const all=task?.events??[];
    let start=0;for(let i=0;i<all.length;i++)if(all[i].type==='followup')start=i;
    const events=all.slice(start),rows=[];
    let model;
    for(const event of events){
      if(event.type==='model_started'){
        if(model)Object.assign(model,{status:'interrupted',end:event.time});
        model={key:event.sequence,tool:'model',status:'running',start:event.time};
        rows.push(model);
      }else if(event.type==='model_finished'){
        if(model)Object.assign(model,{status:'completed',end:event.time,summary:event.summary});
        model=undefined;
      }else if(event.type==='tool_started'){
        if(model)Object.assign(model,{status:'completed',end:event.time});
        model=undefined;
        rows.push({key:event.sequence,tool:event.tool,status:'running',start:event.time});
      }
      else if(['tool_completed','tool_failed'].includes(event.type)){
        const row=[...rows].reverse().find(row=>row.tool===event.tool&&row.status==='running');
        const value={status:event.type==='tool_failed'?'failed':'completed',end:event.time,operation:event.operation_id,
          result:event.result_artifact_id||event.operation_id?event.sequence:undefined};
        if(row)Object.assign(row,value);else rows.push({key:event.sequence,tool:event.tool,start:event.time,incomplete:true,...value});
      }else if(['context_compacting','context_compacted'].includes(event.type)){
        if(event.type==='context_compacting')rows.push({key:event.sequence,tool:'context',status:'running',start:event.time});
        else{const row=[...rows].reverse().find(row=>row.tool==='context'&&row.status==='running');if(row)Object.assign(row,{status:'completed',end:event.time});}
      }else if(['stopped','failed','interrupted','completed'].includes(event.type)){
        for(const row of rows)if(row.status==='running')Object.assign(row,{status:row===model&&event.type==='completed'?'completed':'interrupted',end:event.time});
        model=undefined;
      }
    }
    const active=['queued','running'].includes(task?.status);
    if(!active)for(const row of rows)if(row.status==='running')row.status=task?.status==='completed'?'interrupted':task?.status;
    const groups=[];
    for(const row of rows){const last=groups.at(-1);if(last?.tool===row.tool)last.rows.push(row);else groups.push({key:row.key,tool:row.tool,rows:[row]});}
    for(const group of groups)group.status=group.rows.some(row=>row.status==='running')?'running':group.rows.some(row=>row.status==='failed')?'failed':group.rows.every(row=>row.status==='completed')?'completed':'interrupted';
    const pending=[...rows].reverse().find(row=>row.status==='running');
    const last=events.at(-1),first=events[0];
    const elapsed=first?Math.max(0,((active?now:Date.parse(last.time))-Date.parse(first.time))/1000):0;
    const current=task?.status==='queued'?'queued':pending?.tool==='model'&&task?.live?.text?'answer':
      pending?.tool??(task?.live?.text?'answer':last?.type==='context_compacting'?'context':'model');
    return {groups,active,current,elapsed,operations:rows.filter(row=>!['context','model'].includes(row.tool)).length,
      partial:Boolean(task?.events_archived&&start===0),turn:events[0]?.sequence??0};
  }
  window.SapLinkActivity={build};
})();
