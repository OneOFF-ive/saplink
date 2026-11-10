export function automaticTitle(prompt:string) {
  const text=prompt.replace(/[`*#]/g,'').replace(/\s+/g,' ').trim();
  const intent=text.split(/[，。！？；;]/)[0];
  const object=text.match(/\b[ZY][A-Z0-9_]{2,}\b/i)?.[0].toUpperCase();
  const action=/影响|修改/.test(intent)?'影响分析':/报错|错误|故障|异常|排查/.test(intent)?'问题排查':/解释|逻辑|实现|分析|程序/.test(intent)?'程序分析':'';
  const title=object?(action?`${object} ${action}`:object):/影响|修改/.test(intent)?'修改影响分析':text.replace(/^(?:请帮我|请|帮我|麻烦|我想|希望)\s*/,'').split(/[，。！？\n]/)[0];
  const chars=Array.from(title||'新对话');
  return chars.length>18?chars.slice(0,17).join('')+'…':chars.join('');
}
export function taskTitle(task:{title?:string;prompt:string}) { return task.title??automaticTitle(task.prompt); }
