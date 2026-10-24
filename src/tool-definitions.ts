import { z } from 'zod';
import { repositorySchemas, repositoryDescriptions } from './repository-query.js';
import { enhancementTypes } from './enhancements.js';
import { tableQuerySchema, sqlQuerySchema } from './data-query.js';
import { functionModuleSyntaxHelp } from './function-help.js';

const connectionIdSchema = z.string().uuid();

const connection = { connection_id: connectionIdSchema.describe('Stable UUID returned by list_connections. Select the intended SAP system and Client; do not use the connection name here.') };

const adtUriSchema = z.string().min(1).max(2048).describe('Relative /sap/bc/adt/... URI returned by SAP discovery or a prior tool. No full URLs, query strings or fragments. Never invent source paths.');

const version = z.enum(['active', 'inactive']);

const limit = z.number().int().min(1).max(500).default(100);

const packageNameSchema = z.string().regex(/^[A-Za-z0-9_$/]+$/).max(128);

const transportTaskSchema = z.string().regex(/^[A-Za-z0-9]+$/).max(30).optional()
  .describe(("Required on each create or update_source call when SAP requires change recording, not merely because a " +
    "package is not $TMP. If omitted, the service queries SAP; confirmed local/no-recording packages need no " +
    "task. Unknown requirements block writing. Tasks are not remembered or inherited. Use " +
    "list_transport_requests or ask the user; never invent a task ID."));

const requestIdSchema = z.string().min(1).max(128).describe(("Unique ID for one intended write, scoped to this connection across all write tools. Identical ID and " +
  "arguments return a cached result only in this service process. Inspect SAP state before retrying " +
  "uncertain writes with a new ID."));

export const toolSchemas = {
  get_ddic_definition: repositorySchemas.get_ddic_definition.extend(connection),
  get_data_element: repositorySchemas.get_data_element.extend(connection),
  get_domain_values: repositorySchemas.get_domain_values.extend(connection),
  find_references: repositorySchemas.find_references.safeExtend(connection),
  find_definition: repositorySchemas.find_definition.safeExtend(connection),
  get_class_structure: repositorySchemas.get_class_structure.extend(connection),
  get_type_hierarchy: repositorySchemas.get_type_hierarchy.extend(connection),
  list_connections: z.object({}).strict(),
  get_capabilities: z.object(connection).strict(),
  search_enhancements: z.object({
    ...connection,
    query: z.string().trim().min(1).max(128).describe('Repository name pattern, e.g. Z* or *MATERIAL*. Use a narrow pattern where possible.'),
    type: z.enum(['all', ...enhancementTypes]).default('all').describe(("SMOD exits; CMOD projects; SXSD/SXCI classic BAdI definitions/implementations; ENHS/ENHO " +
      "spots/implementations; ENSC/ENHC composite spots/implementations. all queries every family.")),
    limit
  }).strict(),
  query_table: tableQuerySchema.extend(connection),
  query_sql: sqlQuerySchema.extend(connection),
  search_objects: z.object({
    ...connection,
    query: z.string().min(1).max(128),
    type: z.string().max(30).optional(),
    limit
  }).strict(),
  list_package_objects: z.object({
    ...connection,
    package_name: packageNameSchema,
    limit
  }).strict(),
  read_source: z.object({
    ...connection,
    object_uri: adtUriSchema,
    source_uri: adtUriSchema.optional(),
    version: version.default('active')
  }).strict(),
  create_program: z.object({
    ...connection,
    name: z.string().regex(/^[ZY][A-Z0-9_]{0,29}$/),
    program_kind: z.enum(['report', 'include', 'module_pool', 'subroutine_pool']).default('report'),
    description: z.string().min(1).max(60),
    package_name: packageNameSchema,
    transport_task: transportTaskSchema,
    request_id: requestIdSchema
  }).strict(),
  create_function_group: z.object({
    ...connection,
    name: z.string().regex(/^[ZY][A-Z0-9_]{0,25}$/),
    description: z.string().min(1).max(60),
    package_name: packageNameSchema,
    transport_task: transportTaskSchema,
    request_id: requestIdSchema
  }).strict(),
  create_function_module: z.object({
    ...connection,
    name: z.string().regex(/^[ZY][A-Z0-9_]{0,29}$/),
    description: z.string().min(1).max(60),
    function_group_uri: adtUriSchema,
    transport_task: transportTaskSchema,
    request_id: requestIdSchema
  }).strict(),
  list_function_group_members: z.object({
    ...connection,
    function_group_uri: adtUriSchema,
    limit
  }).strict(),
  get_function_group: z.object({
    ...connection,
    function_group_uri: adtUriSchema
  }).strict(),
  update_source: z.object({
    ...connection,
    object_uri: adtUriSchema.optional(),
    source_uri: adtUriSchema.optional(),
    source: z.string().max(1024 * 1024),
    expected_revision: z.string().regex(/^[a-f0-9]{64}$/).describe(("Exact revision from read_source for this source and connection. On conflict reread and merge; do not " +
      "substitute a new revision without reviewing the source.")),
    transport_task: transportTaskSchema,
    request_id: requestIdSchema
  }).strict()
    .refine(p => Boolean(p.object_uri || p.source_uri), { message: 'Provide object_uri or source_uri' }),
  syntax_check: z.object({
    ...connection,
    object_uri: adtUriSchema,
    version: version.default('inactive')
  }).strict(),
  activate_objects: z.object({
    ...connection,
    objects: z.array(z.object({
      object_uri: adtUriSchema,
      expected_revision: z.string().regex(/^[a-f0-9]{64}$/)
    }).strict()).min(1).max(20),
    request_id: requestIdSchema
  }).strict(),
  list_transport_requests: z.object(connection).strict(),
  create_transport_request: z.object({
    ...connection,
    object_uri: adtUriSchema.describe('Existing or intended Program, Include, function group or function module object URI, not source/main.'),
    package_name: packageNameSchema,
    description: z.string().trim().min(1).max(60),
    request_id: requestIdSchema
  }).strict()
};

const toolDescriptions: Record<ToolName, string> = {
  ...repositoryDescriptions,
  list_connections: ("List configured SAP connections with Client, language, username, backend URL and write policy. Confirm " +
    "the intended system and Client before writing."),
  get_capabilities: 'Probe ADT discovery. A capability does not imply write authorization.',
  search_enhancements: ("Read-only repository name search across customer exits (SMOD), projects (CMOD), classic BAdIs " +
    "(SXSD/SXCI), enhancement spots and implementations (ENHS/ENHO/ENSC/ENHC). Use * wildcards; type defaults " +
    "to all. Returns categories, ADT URIs and coverage limitations. Implementation activation.status is " +
    "active, active_with_inactive_version, or unknown, based on matching ADT version metadata; definitions are " +
    "not_applicable. Inspect activation.probes for evidence and failures. These are repository versions: " +
    "runtime_enabled remains unknown; never infer BAdI switches, filters or CMOD project enablement from " +
    "active version availability. Empty results do not prove absence: ADT may not expose these types. New BAdI " +
    "elements and transaction associations are not enumerated."),
  query_table: ("Read table or supported DDIC/CDS entity data via DDIC Data Preview. Use table_name, optional fields and " +
    "AND-combined filters (eq/ne/gt/ge/lt/le/like). Values are strings; LIKE uses SQL % and _ wildcards. " +
    "Default limit 100, maximum 500. Returns column metadata and raw string rows, preserving leading zeros and " +
    "decimal precision. SAP controls entity support and permissions. Uses configured Client; no cross-client " +
    "override. No stable ordering or pagination is promised. Basic queries use an empty preview body for older " +
    "systems; projection/filter support depends on SAP. Does not require write_enabled."),
  query_sql: ("Run one read-only ABAP SQL SELECT through SAP freestyle Data Preview, subject to backend version and " +
    "permissions. Supports joins, aggregations and subqueries as accepted by SAP. No comments, statement " +
    "terminators, INTO, writes, client overrides or privileged access. Default limit 100, maximum 500; returns " +
    "raw string values and column metadata. Limit bounds returned rows, not backend scan cost. Uses configured " +
    "Client. No pagination. Does not require write_enabled. Query get_capabilities for discovery " +
    "advertisement; unadvertised is not proof of unavailability."),
  search_objects: 'Search SAP repository objects and return relative ADT object URIs.',
  list_package_objects: 'List package contents with a limit. Pagination is not supported in this release.',
  read_source: 'Read the exact active or inactive main source. Keep the revision for a later update.',
  create_program: ("Create a Program or Include shell. program_kind: report (default), include, module_pool or " +
    "subroutine_pool. Subject to SAP support and permissions. Does not activate. Follow returned next_action " +
    "to read the source URI and revision discovered by SAP; do not construct source paths. Do not blindly " +
    "retry unknown results."),
  create_function_group: ("Create a function group (FUGR/F) shell in a package. Does not activate. Follow next_action to obtain its " +
    "snapshot; groups have no main source."),
  create_function_module: ("Create an empty function module (FUGR/FF) in an existing function group, under its group lock. Interface " +
    "parameters are not configured. Does not activate. Follow next_action to read the source URI and revision " +
    "discovered by SAP; do not construct source paths."),
  list_function_group_members: 'List function modules and Includes of a function group, excluding category nodes.',
  get_function_group: ("Snapshot function group members and source revisions for group activation. Pass the returned revision to " +
    "activate_objects for the group. Rejects groups exceeding 500 members."),
  update_source: ("Save Program, Include, function module or group Include main source with expected revision. Does not " +
    "activate. Inspect source_save even on errors: saved=true means SAP accepted the save, not that content " +
    "verification passed; unknown requires reading backend state. Read inactive before retrying VERIFY_FAILED, " +
    "and do not use its revision to blindly overwrite. Function modules use their own lock and ADT " +
    "source-based declarations: TABLES T_RETURN TYPE BAPIRET2 OPTIONAL, not legacy STRUCTURE or Local " +
    "Interface comments. EXCEPTIONS lists names only, e.g. INVALID_INPUT., never INVALID_INPUT = 1 (that is " +
    "CALL FUNCTION syntax). End the definition with a period. Definition comments may be lost; implementation " +
    "comments must not start with reserved prefixes *\" or *\"---. SAP may normalize the definition."),
  syntax_check: 'Check the requested version and return backend diagnostics.',
  activate_objects: ("Activate selected source objects with inactive revisions, or a function group with the revision from " +
    "get_function_group. Group activation affects its members. May partially succeed."),
  list_transport_requests: ("List the configured SAP user transport requests and tasks. Use this to find an existing modifiable task " +
    "when SAP requires change recording; package names alone do not establish that requirement. Confirm the " +
    "intended task with the user if ambiguous. Does not create or release requests or select a default task."),
  create_transport_request: ("Create a new workbench development transport request for an existing or intended supported ABAP object " +
    "and target package. Requires write_enabled and request_id. Query existing requests first and confirm that " +
    "the user wants a NEW request. SAP CTS preflight must require recording. Returns the SAP number and " +
    "verified parent request and current-user tasks separately; never assume the returned number is a task. " +
    "Does not create a program, select a default task, release transports or support arbitrary Customizing " +
    "requests. On unknown outcome or TRANSPORT_VERIFY_FAILED query list_transport_requests before any retry; " +
    "do not blindly create duplicates.")
};

export type ToolName = keyof typeof toolSchemas;

export function toolDescription(name: ToolName): string {
  let description = toolDescriptions[name];
  if (name === 'update_source') {
    description = ("Provide object_uri or the source_uri returned by read_source (both must match if supplied). The main " +
      "source URI is discovered under lock; expected_revision from read_source is still required. Supported " +
      "function definitions permit token-equivalent formatting only; see source_save.normalization_applied, " +
      "difference and warnings for definition comment changes. Unknown grammar falls back to strict " +
      "verification; implementation comparison is unchanged. ") + toolDescriptions[name];
  }
  if (name === 'create_function_module' || name === 'update_source') {
    description += ' ' + functionModuleSyntaxHelp;
  }
  else if (name === 'read_source') {
    description += (" If inactive returns VERSION_UNAVAILABLE, follow error.details.next_action to explicitly read active and " +
      "obtain its revision. This is not proof of activation; no silent version fallback occurs.");
  }
  if (['create_program', 'create_function_group', 'create_function_module', 'update_source'].includes(name)) {
    description += (" transport_task is required on each call when SAP requires change recording, including update_source of " +
      "existing objects. A task supplied earlier is NOT remembered or inherited. If omitted outside $TMP, the " +
      "service performs a read-only SAP CTS check before locking or writing: required returns " +
      "TRANSPORT_REQUIRED; confirmed no-recording permits omission; failed or ambiguous checks return " +
      "TRANSPORT_CHECK_UNAVAILABLE without writing. Package names alone do not determine transportability. Use " +
      "list_transport_requests or ask the user for a modifiable task; never guess a task or confuse it with its " +
      "parent request. SAP makes final task/ownership validation.");
  }
  return description;
}
