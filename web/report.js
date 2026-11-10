/* Parse only the report's explicit inventory table. No HTML is interpreted. */
(() => {
  function parse(content) {
    const lines=content.split('\n'),objects=[],seen=new Set();
    let start=-1,end=-1,fenced=false;
    const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(value=>value.trim().replace(/\\\|/g,'|').replace(/\*\*|`/g,''));
    for(let i=0;i<lines.length;i++){
      if(lines[i].trim().startsWith('```')){fenced=!fenced;continue;}
      if(fenced||!/^#{1,4}\s+已定位关键对象\s*$/.test(lines[i].trim()))continue;
      let header=i+1;while(header<lines.length&&!lines[header].trim())header++;
      if(cells(lines[header]??'').join('|')!=='对象|类型|用途|关联')continue;
      if(!/^\s*\|?\s*:?-{3,}:?\s*\|/.test(lines[header+1]??''))continue;
      let row=header+2;
      while(row<lines.length&&lines[row].trim().startsWith('|')){
        const values=cells(lines[row]);
        if(values.length===4&&values[0]&&!['无','暂无','未定位','未核实','—','-'].includes(values[0])){
          const key=values[0].toUpperCase();
          if(!seen.has(key)){seen.add(key);objects.push({name:values[0],type:values[1]||'未核实',purpose:values[2]||'未核实',relation:values[3]||'未核实'});}
        }
        row++;
      }
      if(objects.length){start=i;end=row;break;}
    }
    const types=[['ABAP程序','ABAP类','程序','类'],['标准表','自定义表','表'],['配置','配置项'],['接口']];
    return {objects,counts:objects.length?types.map(group=>objects.filter(item=>group.includes(item.type.replace(/\s/g,''))).length):null,
      inventory:start<0?null:lines.slice(start,end).join('\n'),
      body:start<0?content:[...lines.slice(0,start),...lines.slice(end)].join('\n').trim()};
  }
  const categories=['对象','调用链','业务解读','影响分析','改造建议','完整结论'];
  function sections(content) {
    const buckets=new Map(),lines=content.split('\n');
    let current,buffer=[],preamble=[],fence,typed=false;
    const flush=()=>{if(current){const text=buffer.join('\n').trim(),meaningful=text.replace(/^#{1,6}\s+.*$/gm,'').trim();if(meaningful&&!/^(?:暂无|无|不适用|未提供|待补充)[。！\s]*$/.test(meaningful))buckets.set(current,[buckets.get(current),text].filter(Boolean).join('\n\n'));}else preamble.push(...buffer);buffer=[];};
    for(const line of lines){
      const marker=line.trim().match(/^(`{3,}|~{3,})/);
      if(marker){if(!fence)fence=marker[1][0];else if(fence===marker[1][0])fence=undefined;buffer.push(line);continue;}
      const heading=!fence&&line.trim().match(/^##\s+(.+?)\s*#*$/);
      if(heading&&categories.includes(heading[1])){flush();current=heading[1];typed=true;}
      else buffer.push(line);
    }
    flush();
    if(typed){
      const extra=preamble.join('\n').trim();
      if(extra.replace(/^#{1,6}\s+.*$/gm,'').trim())buckets.set('完整结论',[extra,buckets.get('完整结论')].filter(Boolean).join('\n\n'));
    }else{
      const legacy=parse(content);
      if(legacy.objects.length)buckets.set('对象',legacy.inventory);
      // Legacy analysis stays intact in a dedicated conclusion tab.
      if(legacy.body.trim())buckets.set('完整结论',legacy.body);
    }
    return categories.filter(name=>buckets.has(name)).map(name=>({name,content:buckets.get(name)}));
  }
  function blocks(content,fallback) {
    const result=[];let title=fallback,lines=[],fence;
    const flush=()=>{const text=lines.join('\n').trim();if(text)result.push({title,content:text});lines=[];};
    for(const line of content.split('\n')){
      const marker=line.trim().match(/^(`{3,}|~{3,})/);
      if(marker){if(!fence)fence=marker[1][0];else if(fence===marker[1][0])fence=undefined;lines.push(line);continue;}
      const heading=!fence&&line.match(/^###\s+(.+?)\s*#*$/);
      if(heading){flush();title=heading[1];}else lines.push(line);
    }
    flush();return result;
  }
  function metrics(content){
    const allowed=['直接修改对象','关联对象','需回归接口','风险等级'],rows=[];
    let fence;
    for(const line of content.split('\n')){
      const marker=line.trim().match(/^(`{3,}|~{3,})/);if(marker){if(!fence)fence=marker[1][0];else if(fence===marker[1][0])fence=undefined;continue;}if(fence)continue;
      const values=line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(text=>text.trim().replace(/\*\*|`/g,''));
      if(values.length===2&&allowed.includes(values[0])&&values[1]&&!['未核实','未知','暂无','—','-'].includes(values[1])&&!rows.some(row=>row.label===values[0]))rows.push({label:values[0],value:values[1]});
    }
    return rows;
  }
  window.SapLinkReport={parse,sections,blocks,metrics};
})();
