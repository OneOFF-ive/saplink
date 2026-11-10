import { AppError } from './errors.js';

export type DdicKind = 'structure' | 'table';
export const ddicTypes = {
  structure: { collection: '/sap/bc/adt/ddic/structures', type: 'TABL/DS', maxName: 30 },
  table: { collection: '/sap/bc/adt/ddic/tables', type: 'TABL/DT', maxName: 16 }
} as const;

export function ddicCreationUri(kind: DdicKind, name: string) {
  return ddicTypes[kind].collection + '/' + encodeURIComponent(name.toLowerCase());
}

// Dictionary DDL is regenerated from metadata. Ignore formatting and keyword
// case, while retaining literal values, operators and numeric token boundaries.
export function ddlTokens(source: string) {
  const tokens = [...source.matchAll(/'(?:[^']|'')*'|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[a-z_][a-z_0-9]*|[0-9]+|[^\s]/gi)]
    .map(match => match[0])
    .filter(token => !token.startsWith('//') && !token.startsWith('/*'))
    .map(token => token.startsWith("'") ? token : token.toLowerCase());
  // ADT regenerates this annotation with a dotted spelling on some releases.
  for (let i=0;i<tokens.length-5;i++) {
    if (tokens[i]==='@' && tokens[i+1]==='abapcatalog' && tokens[i+2]==='.' &&
        tokens[i+3]==='enhancement' && tokens[i+4]==='.' && tokens[i+5]==='category')
      tokens.splice(i+3,3,'enhancementcategory');
  }
  return tokens;
}

function definitions(tokens: string[]) {
  return tokens.flatMap((token,index)=>token==='define' && ['table','structure'].includes(tokens[index+1])
    ? [tokens.slice(index+1,index+4)] : []);
}

export function verifyDdicDefinition(kind: DdicKind, name: string, source: string) {
  if (!/^[ZY][A-Z0-9_]*$/.test(name) || name.length > ddicTypes[kind].maxName)
    throw new AppError('INVALID_INPUT', `Use a Z/Y name with at most ${ddicTypes[kind].maxName} characters.`);
  const tokens = ddlTokens(source);
  const declared = definitions(tokens);
  if (declared.length !== 1 || declared[0][0] !== kind || declared[0][1] !== name.toLowerCase() ||
      declared[0][2] !== '{' || tokens.at(-1) !== '}')
    throw new AppError('INVALID_INPUT', `Provide one complete DEFINE ${kind.toUpperCase()} ${name} definition.`);
  if (kind === 'table' && tokens.some((token,index) => token === 'tablecategory' && tokens[index-1] === '.' &&
      (tokens[index+2] !== '#' || tokens[index+3] !== 'transparent')))
    throw new AppError('INVALID_INPUT','Only transparent database tables are supported.');
}

export function verifyDdicUpdate(name: string, baseline: string, proposed: string) {
  const kind = definitions(ddlTokens(baseline))[0]?.[0];
  if (kind !== 'structure' && kind !== 'table')
    throw new AppError('CAPABILITY_UNSUPPORTED','SAP did not return a supported Dictionary structure or table definition.');
  verifyDdicDefinition(kind,name,baseline);
  verifyDdicDefinition(kind,name,proposed);
}

export function sameDdicDefinition(left: string, right: string) {
  return JSON.stringify(ddlTokens(left)) === JSON.stringify(ddlTokens(right));
}
