import { z } from 'zod';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ADTClient, ClassComponent } from 'abap-adt-api';
import { AppError, safeError } from './errors.js';
import { findReferences } from './reference-query.js';

const uri = z.string().min(1).max(2048).describe('Relative ADT object URI returned by SAP search or a prior tool. No full URL, query or fragment.');
const name = z.string().regex(/^(?:\/[A-Za-z0-9_]+\/)?[A-Za-z0-9_]+$/).max(128);
const limit = z.number().int().min(1).max(500).default(100);
const line = z.number().int().min(1).max(1000000).describe('One-based line in the active source.');
const column = z.number().int().min(1).max(1000000).describe('One-based column in the active source (UTF-16 code units).');
const position = { object_uri: uri, line, column };

export const repositorySchemas = {
  get_ddic_definition: z.object({ entity_name: name.describe('DDIC table, structure or supported CDS entity name.'),
    field_name: name.optional().describe('Optional exact field name.'), limit }).strict(),
  get_data_element: z.object({ data_element_uri: uri }).strict(),
  get_domain_values: z.object({ domain_uri: uri, limit }).strict(),
  find_references: z.object({ object_uri: uri, line: line.optional(), column: column.optional(), limit }).strict()
    .refine(p => (p.line === undefined) === (p.column === undefined), 'Provide both line and column, or neither'),
  find_definition: z.object({ ...position, end_column: column.optional(), implementation: z.boolean().default(false) }).strict()
    .refine(p => p.end_column === undefined || p.end_column >= p.column, 'end_column must not precede column'),
  get_class_structure: z.object({ object_uri: uri, limit }).strict(),
  get_type_hierarchy: z.object({ ...position, direction: z.enum(['super', 'sub']).default('super'), limit }).strict()
};
export type RepositoryTool = keyof typeof repositorySchemas;
export type RepositoryInput = {
  entity_name?: string; field_name?: string; data_element_uri?: string; domain_uri?: string;
  object_uri?: string; line?: number; column?: number; end_column?: number;
  implementation?: boolean; direction?: 'super' | 'sub'; limit?: number;
};
const coverage = 'SAP version, authorization and index coverage apply. Empty results do not prove absence. No pagination cursor.';
export const repositoryDescriptions: Record<RepositoryTool, string> = {
  get_ddic_definition: 'Read DDIC/CDS field definitions: types, lengths, keys, data elements and available labels. Optional field_name filters returned metadata locally; SAP may return the whole entity. Active backend metadata only; not business rows. Nested elements are flattened with parent indexes; limit bounds total returned elements. Support varies by backend.',
  get_data_element: 'Read active data element metadata, labels and type/domain information. Obtain data_element_uri from search_objects (DTEL), not by constructing a path. Domain typeName is backend metadata, not a business table.',
  get_domain_values: 'Read active domain metadata and fixed values/ranges, preserving raw strings and leading zeros. Obtain domain_uri from search_objects (DOMA). Fixed values are not all business-valid values; a value table is not automatically a validated check table. Does not query value tables.',
  find_references: `Read actual SAP where-used locations and bounded code snippets for an object or a symbol at line/column in its active main source. Omit both position fields for object-wide references. Input and returned location coordinates are one-based; source_context identifies the source used. Groups expand via usageSnippets: at most 6 requests / 25 groups / 30 seconds (checked between requests). limit counts actual locations, not groups. Inspect unexpanded_nodes, truncation_reasons and expansion_complete; partial expansion never proves absence. ${coverage} Does not establish a complete call graph or detect every dynamic call.`,
  find_definition: 'Locate a symbol definition (or implementation=true) using current active main source fetched by the server. Supply object_uri from search, one-based line/column and optional inclusive end_column. Returns SAP target location and queried source revision; no source is saved. Includes requiring main-program context may be unsupported.',
  get_class_structure: 'Read active class or interface member structure: names, types, visibility and available static/constant/read-only flags. Pass class/interface object URI from SAP search. Returned SAP link fragments retain native zero-based columns. Flattened members carry parent indexes; limit bounds total members. Complete method signatures and inherited members are not guaranteed; use get_type_hierarchy for inheritance.',
  get_type_hierarchy: `Read backend type hierarchy entries at a symbol in active main source. direction=super (default) or sub. Coordinates are one-based. Does not recursively crawl the entire hierarchy. ${coverage}`
};

function page<T>(items: T[], max: number) {
  return { items: items.slice(0, max), returned_count: Math.min(items.length, max), truncated: items.length > max,
    pagination_supported: false as const };
}
// A nested structure cannot bypass the total result limit. Parent indexes refer
// only to nodes already included in the flattened result (root counts as one).
export function flattenTree<T>(root: T, children: (node: T) => T[], max: number) {
  const items: { node: T; parent_index: number | null }[] = [];
  const stack = [{ node: root, parent_index: null as number | null }];
  while (stack.length && items.length < max) {
    const item = stack.pop()!;
    const parent_index = items.length;
    items.push(item);
    const descendants = children(item.node);
    for (let i = descendants.length - 1; i >= 0; i--) stack.push({ node: descendants[i], parent_index });
  }
  return { items, returned_count: items.length, truncated: stack.length > 0, pagination_supported: false as const };
}
function malformed(message: string): never { throw new AppError('INVALID_BACKEND_RESPONSE', message); }
// Generic library parsing coerces numeric XML tag values. Domain identifiers and
// ranges must retain leading zeros and decimal precision, so parse raw XML here.
export function parseDomain(xml: string, max: number) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) malformed('Invalid domain metadata XML');
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true,
    parseTagValue: false, parseAttributeValue: false, trimValues: false }).parse(xml);
  const root = parsed.domain;
  const content = root?.content;
  if (!root?.['@_name'] || !content?.typeInformation) malformed('Expected SAP domain metadata');
  const values = content.valueInformation;
  const raw = values?.fixValues?.fixValue;
  const rows = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const bounded = page(rows.map((v: { low?: string; high?: string; text?: string }) => ({
    low: v.low ?? '', ...(v.high !== undefined ? { high: v.high } : {}), text: v.text ?? ''
  })), max);
  return { name: root['@_name'], description: root['@_description'] ?? '', language: root['@_language'] ?? '',
    type_information: content.typeInformation, output_information: content.outputInformation ?? {},
    value_table_name: values?.valueTableRef?.['@_name'] ?? null,
    fixed_values_available: raw !== undefined, ...bounded, limitations: [
      'Fixed values/ranges are domain metadata, not all permissible business values.',
      'No value-table rows or check-table validation were requested.'
    ] };
}


type DefinitionNode = { name: string; type: string; properties: unknown; children: DefinitionNode[] };

// The generic DDIC endpoint supports structures that ddl/elementinfo reports as
// an empty elementInfo. Parse namespaces independently and preserve include/type
// references supplied by SAP; no recursive requests or source parsing are needed.
export function parseDdicDefinition(xml: string, entityName: string): DefinitionNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    malformed('Invalid DDIC element metadata XML');
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true,
    parseTagValue: false, parseAttributeValue: false }).parse(xml);
  let count = 0;
  const parseNode = (raw: unknown, depth: number): DefinitionNode => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || depth > 128 || ++count > 10000)
      malformed('Invalid or excessive DDIC element metadata');
    const node = raw as Record<string, unknown>;
    if (typeof node['@_name'] !== 'string' || !node['@_name'] ||
        typeof node['@_type'] !== 'string' || !node['@_type'])
      malformed('Expected named DDIC element metadata');
    const props: Record<string, unknown> = {};
    const rawProperties = node.properties as { entry?: unknown } | undefined;
    const entries = rawProperties?.entry === undefined ? [] :
      Array.isArray(rawProperties.entry) ? rawProperties.entry : [rawProperties.entry];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') malformed('Invalid DDIC property');
      const property = entry as Record<string, unknown>;
      const key = property['@_key'];
      if (typeof key !== 'string' || !key || ['__proto__', 'constructor', 'prototype'].includes(key))
        malformed('Invalid DDIC property key');
      const value = property['#text'] ?? '';
      if (typeof value !== 'string') malformed('Invalid DDIC property value');
      if (key === 'ddicIsKey') props[key] = value === 'true';
      else if (/^ddic(?:Length|Decimals|HeadingLength|Label(?:Short|Medium|Long)Length)$/.test(key)
          && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) props[key] = Number(value);
      else props[key] = value;
    }
    const documentation = node.documentation as Record<string, unknown> | undefined;
    if (documentation?.['@_rel'] === 'shorttext' && documentation['@_type'] === 'text/plain'
        && typeof documentation['#text'] === 'string' && props.ddicLabelLong === undefined)
      props.ddicLabelLong = documentation['#text'];
    const rawChildren = node.elementInfo === undefined ? [] :
      Array.isArray(node.elementInfo) ? node.elementInfo : [node.elementInfo];
    return { name: node['@_name'] as string, type: node['@_type'] as string,
      properties: { elementProps: Object.keys(props).length ? props : false, annotations: [] },
      children: rawChildren.map(child => parseNode(child, depth + 1)) };
  };
  const root = parseNode(parsed.elementInfo, 0);
  if (root.name.toUpperCase() !== entityName.toUpperCase())
    malformed('DDIC metadata does not match the requested entity');
  return root;
}

type ReadSource = (object: string, version: 'active') => Promise<{ source_uri: string; source: string; revision: string }>;
export class RepositoryQueries {
  constructor(private reader: ADTClient, private read: ReadSource, private validateUri: (value: string) => string) {}
  private typedUri(value: string, family: RegExp) {
    const checked = this.validateUri(value);
    if (!family.test(checked)) throw new AppError('INVALID_URI', 'Use the matching DDIC, class or interface object URI returned by SAP');
    return checked;
  }

  private async ddicDefinition(entityName: string): Promise<DefinitionNode> {
    try {
      const root = await this.reader.ddicElement([entityName], false, false, false);
      if (root?.name && root.type) {
        if (root.name.toUpperCase() !== entityName.toUpperCase())
          malformed('DDIC metadata does not match the requested entity');
        return root;
      }
    } catch (error) {
      const status = (safeError(error).details as { http_status?: number } | undefined)?.http_status;
      // Do not retry authentication/authorization failures via another endpoint.
      if (!status || ![404, 405, 500, 501].includes(status)) throw error;
    }
    const response = await this.reader.httpClient.request('/sap/bc/adt/ddic/elementinfo', {
      method: 'GET', headers: { Accept: 'application/vnd.sap.adt.elementinfo+xml' },
      qs: { path: entityName }
    });
    return parseDdicDefinition(response.body, entityName);
  }
  private async sourcePosition(object: string, lineNumber: number, start: number, end = start) {
    const source = await this.read(this.validateUri(object), 'active');
    const text = source.source.replace(/\r\n?/g, '\n').split('\n')[lineNumber - 1];
    if (text === undefined || start > text.length || end > text.length)
      throw new AppError('INVALID_POSITION', 'Position must identify a character in the current active source');
    return { source, context: { source_uri: source.source_uri, revision: source.revision,
      version: 'active' as const, line: lineNumber, column: start } };
  }
  async run(tool: RepositoryTool, input: RepositoryInput): Promise<unknown> {
    // Validate again for direct callers outside MCP.
    switch (tool) {
      case 'get_ddic_definition': {
        const p = repositorySchemas[tool].parse(input);
        const path = [p.entity_name.toUpperCase(), ...(p.field_name ? [p.field_name.toUpperCase()] : [])];
        let root = await this.ddicDefinition(path[0]);
        if (p.field_name) {
          // Older backends ignore additional path segments and return the whole
          // entity. Select matching fields locally before applying the limit.
          const matches: DefinitionNode[] = [];
          const pending = [...(root.children ?? [])].reverse();
          while (pending.length) {
            const node = pending.pop()!;
            if (node.name?.toUpperCase() === path[1]) matches.push(node);
            else for (let i = (node.children?.length ?? 0) - 1; i >= 0; i--) pending.push(node.children[i]);
          }
          if (!matches.length) throw new AppError('DDIC_FIELD_NOT_FOUND',
            'Requested field was not found in the metadata returned by SAP', { entity_name: path[0], field_name: path[1] });
          root = { ...root, children: matches };
        }
        const result = flattenTree<DefinitionNode>(root, n => n.children ?? [], p.limit);
        return { entity_name: path[0], field_name: path[1], version: 'active', ...result,
          items: result.items.map(({ node, parent_index }) => ({ name: node.name, type: node.type,
            parent_index, properties: node.properties })),
          limitations: ['Only metadata exposed by SAP; extension views and secondary objects were not explicitly requested.', 'INCLUDE expansion follows the backend response; table-type references are not recursively expanded.'] };
      }
      case 'get_data_element': {
        const p = repositorySchemas[tool].parse(input);
        const object = this.typedUri(p.data_element_uri, /^\/sap\/bc\/adt\/ddic\/dataelements\/[^/]+$/);
        const result = await this.reader.getDataElementProperties(object, 'active');
        if (!result.metaData?.name || !result.properties?.fieldLabels) malformed('Expected data element metadata');
        return { object_uri: object, version: 'active', metadata: result.metaData, properties: result.properties };
      }
      case 'get_domain_values': {
        const p = repositorySchemas[tool].parse(input);
        const object = this.typedUri(p.domain_uri, /^\/sap\/bc\/adt\/ddic\/domains\/[^/]+$/);
        return { object_uri: object, version: 'active', ...parseDomain(await this.reader.getObjectSource(object, { version: 'active' }), p.limit) };
      }
      case 'find_references': {
        const p = repositorySchemas[tool].parse(input);
        const object = this.validateUri(p.object_uri);
        const positioned = p.line !== undefined ? await this.sourcePosition(object, p.line, p.column!) : undefined;
        // Embed the validated position ourselves: the dependency treats column
        // zero as 'no position' when supplied as a separate argument.
        const referenceUri = positioned ? `${positioned.source.source_uri}#start=${p.line},${p.column! - 1}` : object;
        return { object_uri: object, source_context: positioned?.context,
          ...await findReferences(this.reader, referenceUri, p.limit, this.validateUri, { object_uri: object }) };
      }
      case 'find_definition': {
        const p = repositorySchemas[tool].parse(input);
        const { source, context } = await this.sourcePosition(p.object_uri, p.line, p.column, p.end_column);
        const result = await this.reader.findDefinition(source.source_uri, source.source, p.line, p.column - 1,
          p.end_column ?? p.column, p.implementation);
        if (!result.url) throw new AppError('DEFINITION_NOT_FOUND', 'SAP returned no definition target');
        return { source_context: context, target: { ...result, line: result.line || undefined, column: result.line > 0 ? result.column + 1 : undefined }, implementation: p.implementation };
      }
      case 'get_class_structure': {
        const p = repositorySchemas[tool].parse(input);
        const object = this.typedUri(p.object_uri, /^\/sap\/bc\/adt\/oo\/(?:classes|interfaces)\/[^/]+$/);
        const root = await this.reader.classComponents(object);
        if (!root?.['adtcore:name'] || !root['adtcore:type']) malformed('Expected class or interface structure');
        const result = flattenTree<ClassComponent>(root, n => n.components ?? [], p.limit);
        return { object_uri: object, version: 'active', ...result,
          items: result.items.map(({ node, parent_index }) => ({ name: node['adtcore:name'], type: node['adtcore:type'],
            parent_index, visibility: node.visibility, constant: node.constant, level: node.level,
            read_only: node.readOnly, links: node.links, base_uri: node['xml:base'] })),
          limitations: ['Backend member outline only; complete signatures and inherited members are not guaranteed.'] };
      }
      case 'get_type_hierarchy': {
        const p = repositorySchemas[tool].parse(input);
        const { source, context } = await this.sourcePosition(p.object_uri, p.line, p.column);
        const rows = await this.reader.typeHierarchy(source.source_uri, source.source, p.line, p.column - 1, p.direction === 'super');
        return { source_context: context, direction: p.direction, ...page(rows.map(node => ({ ...node, line: node.line || undefined, column: node.line > 0 ? node.character + 1 : undefined, character: undefined })), p.limit),
          limitations: [coverage, 'Only the backend response for this symbol; no recursive hierarchy traversal.'] };
      }
    }
  }
}
