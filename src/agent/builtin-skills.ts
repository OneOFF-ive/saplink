import { readFile } from 'node:fs/promises';
import { prepareSkillDraft } from './skill-packages.js';

export const skillCreatorId = 'b189637b-a229-40e5-b4d6-06fde5e92a01';
const bundled = [
  {id:skillCreatorId,name:'技能生成',folder:'saplink-skill-creator'},
  {id:'b189637b-a229-40e5-b4d6-06fde5e92a02',name:'SapLink',folder:'saplink-assistant'}
];
export const builtinSkillIds = bundled.map(skill=>skill.id);
let loaded: ReturnType<typeof loadBuiltinSkills> | undefined;
async function loadBuiltinSkills() {
  return Promise.all(bundled.map(async ({id,name,folder})=>{
    const body = await readFile(new URL(`../../skills/${folder}/SKILL.md`,import.meta.url),'utf8');
    const {description,files} = prepareSkillDraft({files:[{path:'SKILL.md',text:body}]});
    return {id,name,body,description,files:files.map(file=>file.path),builtin:true as const};
  }));
}
export function builtinSkills() {
  return loaded ??= loadBuiltinSkills();
}
