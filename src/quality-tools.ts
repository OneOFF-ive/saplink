import { z } from 'zod';
import { XMLBuilder } from 'fast-xml-parser';
import type { ADTClient } from 'abap-adt-api';
import { atcCustomizing, atcCheckVariant, createAtcRun, atcWorklists } from 'abap-adt-api/build/api/atc.js';
import type { AdtHTTP } from 'abap-adt-api/build/AdtHTTP.js';
import { AppError, safeError } from './errors.js';
import { digest } from './config.js';
import { sourceDiff } from './source-diff.js';
import { qualityXml, xmlArray, versionResource, parseVersions } from './source-versions.js';

const objectUri = z.string().min(1).max(2048).describe('Supported class/interface, Program/Include or function-group/member object URI returned by SAP. Not a package or source URI.');
const limit = z.number().int().min(1).max(500).default(100);
const runId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const request = { request_id: z.string().min(1).max(128).describe('Unique ID for this execution; same ID/arguments only retrieves its process-local cached result. Never blindly retry an unknown execution.'),
  confirm_execution: z.literal(true).describe('Set only after the user has authorized running this check or these tests for the selected object.') };
const version = z.string().regex(/^(?:active|inactive|[a-f0-9]{64})$/).describe('active, inactive or an opaque version_id from list_source_versions for this connection/object. Not a numeric SAP revision.');
export const qualitySchemas = {
  get_atc_configuration: z.object({}).strict(),
  run_atc: z.object({ object_uri: objectUri, check_variant: z.string().regex(/^(?:\/[A-Za-z0-9_]+\/)?[A-Za-z0-9_]+$/).max(128),
    max_findings: z.number().int().min(1).max(500).default(100), ...request }).strict(),
  get_atc_results: z.object({ run_id: runId, limit }).strict(),
  run_unit_tests: z.object({ object_uri: objectUri, max_duration: z.enum(['short', 'medium', 'long']).default('short'), limit, ...request }).strict(),
  list_source_versions: z.object({ object_uri: objectUri, limit }).strict(),
  compare_source_versions: z.object({ object_uri: objectUri, from_version: version.default('active'), to_version: version.default('inactive'),
    context_lines: z.number().int().min(0).max(10).default(3), max_diff_lines: z.number().int().min(1).max(2000).default(400) }).strict()
};
export type QualityTool = keyof typeof qualitySchemas;
export type QualityInput = { object_uri?: string; check_variant?: string; max_findings?: number; run_id?: string; request_id?: string;
  confirm_execution?: true; max_duration?: 'short' | 'medium' | 'long'; limit?: number; from_version?: string; to_version?: string;
  context_lines?: number; max_diff_lines?: number };
export const qualityDescriptions: Record<QualityTool, string> = {
  get_atc_configuration: 'Read SAP ATC customizing/default-variant hints. Does not create worklists or execute checks. Use a real backend check variant; do not guess one.',
  run_atc: 'Execute ATC for ONE explicitly selected repository object. Requires write_enabled, user execution authorization, confirm_execution=true and unique request_id. Creates an ATC worklist/run, never saves or activates source. Returns run_id for get_atc_results; submission is not a quality-pass result. No automatic retries, exemptions, transport release or mass package checks.',
  get_atc_results: 'Read an ATC run_id returned by run_atc. Bounded flattened findings with priority, check/message and native SAP location metadata. Empty findings do not certify completion or overall quality; inspect coverage, findings_may_be_limited, assessment and errors. No automatic polling or rerunning.',
  run_unit_tests: 'Execute ABAP Unit for ONE authorized object. Requires write_enabled, confirm_execution=true and unique request_id. HARMLESS risk only; default SHORT duration, optional maximum MEDIUM/LONG. Labels are SAP test metadata, not a sandbox guarantee. Backend code executes; never automatically retry on timeout. No save/activation. No tests, warnings, skipped or unknown methods must not be reported as all tests passing.',
  list_source_versions: 'Read SAP main-source history for ONE object and return opaque version_id selectors. Handles are bound to this connection/object/resource; SAP history may be incomplete. Not Git history; title/transport is not a source version parameter. No deletion or restore.',
  compare_source_versions: 'Read-only line diff of main-source active/inactive or history version_id from list_source_versions. Defaults active -> inactive. No silent inactive fallback. Separate snapshots carry hashes/revisions; not an atomic snapshot of SAP. Bounded diff output; truncated is not a complete patch. No save, restore or activation; class auxiliary parts not supported.'
};

export function qualityObject(value: string, validate: (value: string) => string) {
  const uri = validate(value);
  if (!/^\/sap\/bc\/adt\/(?:(?:oo\/(?:classes|interfaces)|programs\/(?:programs|includes))\/[A-Za-z0-9_%]+|functions\/groups\/[A-Za-z0-9_%]+(?:\/(?:fmodules|includes)\/[A-Za-z0-9_%]+)?)$/.test(uri))
    throw new AppError('CAPABILITY_UNSUPPORTED', 'Select one supported repository object, not a package, collection or source URI');
  return uri;
}
const boundedText = (value: unknown) => String(value ?? '').slice(0, 2000);
function alerts(node: any) {
  return xmlArray<any>(node?.alerts?.alert).map(alert => ({ kind: String(alert['@_kind'] ?? ''), severity: String(alert['@_severity'] ?? ''),
    title: boundedText(alert.title), details: xmlArray<any>(alert.details?.detail).slice(0, 5).map(d => boundedText(d['@_text'] ?? d)),
    stack: xmlArray<any>(alert.stack?.stackEntry).slice(0, 5).map(s => ({ uri: String(s['@_uri'] ?? '').slice(0, 2048), name: boundedText(s['@_name']), description: boundedText(s['@_description']) })) }));
}
export function unitResults(xml: string, limit: number) {
  const root = qualityXml(xml, 'runResult');
  const programs = xmlArray<any>(root.program);
  const globalAlerts = [...alerts(root), ...programs.flatMap(alerts)];
  const classes = programs.flatMap(p => xmlArray<any>(p.testClasses?.testClass));
  const classAlerts = classes.flatMap(alerts);
  const state = (node: any) => String(node['@_executionStatus'] ?? node['@_status'] ?? '').toLowerCase();
  const incomplete = (node: any) => node['@_executed'] === 'false' || node['@_skipped'] === 'true' || node['@_aborted'] === 'true' ||
    ['notexecuted', 'skipped', 'aborted', 'cancelled', 'canceled', 'notrun'].includes(state(node));
  const nodes = [root, ...programs, ...classes];
  const riskViolation = classes.some(c => ['dangerous', 'critical'].includes(String(c['@_riskLevel'] ?? '').toLowerCase()));
  const scopeIncomplete = nodes.some(node => incomplete(node) || !['', 'executed', 'completed', 'finished', 'passed', 'success'].includes(state(node))) || riskViolation;
  const methods = classes.flatMap(c => xmlArray<any>(c.testMethods?.testMethod).map(m => {
    const messages = alerts(m);
    const skipped = incomplete(m);
    const knownState = ['', 'executed', 'completed', 'finished', 'passed', 'success'].includes(state(m));
    const executionTime = m['@_executionTime'];
    const executed = !skipped && knownState && typeof executionTime === 'string' && executionTime.trim() !== '' &&
      Number.isFinite(Number(executionTime)) && Number(executionTime) >= 0;
    return { class_name: boundedText(c['@_name']), name: boundedText(m['@_name']), uri: String(m['@_uri'] ?? '').slice(0, 2048),
      risk_level: boundedText(c['@_riskLevel']), duration_category: boundedText(c['@_durationCategory']),
      execution_time: executed ? Number(m['@_executionTime']) : null, executed, skipped, alerts: messages };
  }));
  const allAlerts = [...globalAlerts, ...classAlerts, ...methods.flatMap(m => m.alerts)];
  const explicitFailure = [...nodes, ...classes.flatMap(c => xmlArray<any>(c.testMethods?.testMethod))]
    .some(node => ['failed', 'failure', 'error'].includes(state(node)));
  const failed = explicitFailure || allAlerts.some(a => a.kind === 'failedAssertion' || a.kind === 'exception' || ['critical', 'fatal'].includes(a.severity));
  const status = failed ? 'failed' : scopeIncomplete ? 'unknown' : methods.length === 0 ? 'no_tests' : methods.some(m => !m.executed) ? 'unknown'
    : allAlerts.length ? 'warning' : 'passed';
  return { test_status: status, risk_policy_violation: riskViolation, classes: classes.length, total_methods: methods.length,
    executed_methods: methods.filter(m => m.executed).length, skipped_methods: methods.filter(m => m.skipped).length,
    items: methods.slice(0, limit).map(m => ({ ...m, alerts: m.alerts.slice(0, 10) })), returned_count: Math.min(limit, methods.length),
    alerts: [...globalAlerts, ...classAlerts].slice(0, 20), alert_count: allAlerts.length,
    truncated: methods.length > limit || allAlerts.length > 20 || methods.some(m => m.alerts.length > 10),
    limitations: ['HARMLESS selection relies on SAP labels and administration. Duration category is not a client wall-clock timeout.',
      'No tests is not a pass. SAP controls code selection; no source was saved or activated.'] };
}

type Snapshot = { source_uri: string; source: string; revision: string; version: string };
type Read = (object: string, version: 'active' | 'inactive') => Promise<Snapshot>;
export class QualityTools {
  constructor(private http: AdtHTTP, private reader: ADTClient, private read: Read,
    private connectionId: string, private origin: string, private validate: (value: string) => string) {}

  private async history(object: string) {
    const metadata = await this.reader.objectStructure(object, 'active');
    let links = metadata.links ?? [];
    let base = object + '/';
    if ('includes' in metadata) {
      const main = metadata.includes.find(include => include['class:includeType'] === 'main');
      links = main?.links ?? [];
      // Include links are relative to the class document, not the main source.
      // SAP can advertise includes/main/versions beside source/main here.
    }
    const discovered = links.find(link => link.rel === 'http://www.sap.com/adt/relations/versions')?.href;
    if (!discovered) throw new AppError('CAPABILITY_UNSUPPORTED', 'SAP metadata exposes no main-source version history');
    const resource = versionResource(discovered, base, this.origin, this.validate);
    const response = await this.http.request(resource, { headers: { Accept: 'application/atom+xml;type=feed' } });
    const parsed = parseVersions(response.body, resource, this.origin, this.validate);
    return { entries: parsed.entries.slice(0, 500).map(entry => ({ ...entry,
      version_id: digest(JSON.stringify([this.connectionId, object, entry.resource])) })), truncated: parsed.has_next || parsed.entries.length > 500 };
  }
  async run(tool: QualityTool, input: QualityInput): Promise<unknown> {
    switch (tool) {
      case 'get_atc_configuration': {
        qualitySchemas[tool].parse(input);
        const data = await atcCustomizing(this.http);
        return { properties: data.properties.slice(0, 200), truncated: data.properties.length > 200,
          limitations: ['Customizing is not authorization or an enumeration of every available variant.'] };
      }
      case 'run_atc': {
        const p = qualitySchemas[tool].parse(input);
        const object = qualityObject(p.object_uri, this.validate);
        let worklist: string | undefined;
        try {
          worklist = runId.parse((await atcCheckVariant(this.http, p.check_variant)).trim());
          const run = await createAtcRun(this.http, worklist, object, p.max_findings);
          return { run_id: runId.parse(run.id), timestamp: run.timestamp, submission: 'accepted',
            infos: run.infos.slice(0, 10).map(i => ({ type: i.type, description: boundedText(i.description) })),
            object_uri: object, check_variant: p.check_variant, max_findings: p.max_findings,
            next_action: { tool: 'get_atc_results', arguments: { connection_id: this.connectionId, run_id: run.id } },
            limitations: ['Run submission is not proof of check completion or code quality. No automatic polling or retry.'] };
        } catch (error) {
          throw new AppError('ATC_EXECUTION_FAILED', 'ATC execution could not be confirmed; inspect SAP state before retrying',
            { worklist_id: worklist, cause: safeError(error) });
        }
      }
      case 'get_atc_results': {
        const p = qualitySchemas[tool].parse(input);
        const result = await atcWorklists(this.http, p.run_id);
        if (result.id !== p.run_id) throw new AppError('ATC_RESULT_MISMATCH', 'SAP returned a different ATC worklist than requested');
        const findings = result.objects.flatMap(object => object.findings.map(finding => ({ object_uri: String(object.uri).slice(0, 2048),
          object_name: boundedText(object.name), package_name: boundedText(object.packageName), priority: finding.priority,
          check_id: finding.checkId, check_title: boundedText(finding.checkTitle), message: boundedText(finding.messageTitle),
          message_id: boundedText(finding.messageId), location: { uri: String(finding.location.uri).slice(0, 2048),
            range: finding.location.range, context: boundedText(finding.location.query?.context) }, exemption: finding.exemptionKind })));
        return { run_id: result.id, timestamp: result.timestamp, execution_status: 'unknown',
          assessment: findings.length ? 'findings_present' : 'no_findings_reported', object_set_complete: result.objectSetIsComplete,
          items: findings.slice(0, p.limit), returned_count: Math.min(findings.length, p.limit), reported_findings: findings.length,
          truncated: findings.length > p.limit || !result.objectSetIsComplete, findings_may_be_limited: true,
          limitations: ['Object-set completeness is not execution completion. No findings is not a quality-pass certificate.',
            'The run maximumVerdicts and SAP permissions may restrict findings. Locations retain native SAP coordinates.'] };
      }
      case 'run_unit_tests': {
        const p = qualitySchemas[tool].parse(input);
        const object = qualityObject(p.object_uri, this.validate);
        const body = new XMLBuilder({ ignoreAttributes: false, suppressBooleanAttributes: false }).build({ 'aunit:runConfiguration': {
          '@_xmlns:aunit': 'http://www.sap.com/adt/aunit', external: { coverage: { '@_active': 'false' } },
          options: { uriType: { '@_value': 'semantic' }, testDeterminationStrategy: { '@_sameProgram': 'true', '@_assignedTests': 'false' },
            testRiskLevels: { '@_harmless': 'true', '@_dangerous': 'false', '@_critical': 'false' },
            testDurations: { '@_short': 'true', '@_medium': String(p.max_duration !== 'short'), '@_long': String(p.max_duration === 'long') },
            withNavigationUri: { '@_enabled': 'true' } },
          'adtcore:objectSets': { '@_xmlns:adtcore': 'http://www.sap.com/adt/core', objectSet: { '@_kind': 'inclusive',
            'adtcore:objectReferences': { 'adtcore:objectReference': { '@_adtcore:uri': object } } } } } });
        const response = await this.http.request('/sap/bc/adt/abapunit/testruns', {
          method: 'POST', body, headers: { 'Content-Type': 'application/*', Accept: 'application/*' } });
        return { object_uri: object, selection: { risk_level: 'harmless', max_duration: p.max_duration }, ...unitResults(response.body, p.limit) };
      }
      case 'list_source_versions': {
        const p = qualitySchemas[tool].parse(input);
        const object = qualityObject(p.object_uri, this.validate);
        const history = await this.history(object);
        return { object_uri: object, source_part: 'main', items: history.entries.slice(0, p.limit).map(({ resource: _resource, ...entry }) => entry),
          returned_count: Math.min(history.entries.length, p.limit), truncated: history.truncated || history.entries.length > p.limit,
          pagination_supported: false, limitations: ['SAP version history only. Handles are connection/object-bound and revalidated when compared.'] };
      }
      case 'compare_source_versions': {
        const p = qualitySchemas[tool].parse(input);
        const object = qualityObject(p.object_uri, this.validate);
        let history: Awaited<ReturnType<QualityTools['history']>> | undefined;
        const snapshots = new Map<string, Snapshot>();
        const snapshot = async (selector: string) => {
          const cached = snapshots.get(selector); if (cached) return cached;
          let value: Snapshot;
          if (selector === 'active' || selector === 'inactive') value = await this.read(object, selector);
          else {
            history ??= await this.history(object);
            const entry = history.entries.find(e => e.version_id === selector);
            if (!entry) throw new AppError('VERSION_NOT_FOUND', 'History selector is unavailable for this connection/object; refresh list_source_versions');
            const response = await this.http.request(entry.resource, { headers: { Accept: 'text/plain' } });
            const contentType = String(response.headers['content-type'] ?? '');
            if (/html|xml/i.test(contentType)) throw new AppError('VERSION_CONTENT_UNSUPPORTED', 'SAP history resource did not return plain source');
            value = { source_uri: entry.resource, source: response.body, version: selector, revision: digest(response.body) };
          }
          if (Buffer.byteLength(value.source) > 1024 * 1024) throw new AppError('DIFF_TOO_LARGE', 'A source snapshot exceeds 1 MiB');
          snapshots.set(selector, value); return value;
        };
        const before = await snapshot(p.from_version), after = await snapshot(p.to_version);
        const info = (s: Snapshot) => ({ version: s.version, source_uri: s.source_uri,
          read_revision: s.version === 'active' || s.version === 'inactive' ? s.revision : undefined, hash: digest(s.source) });
        return { object_uri: object, from: info(before), to: info(after), ...sourceDiff(before.source, after.source, p.context_lines, p.max_diff_lines),
          limitations: ['Separate source reads, not an atomic snapshot. No inactive fallback, save, restore or activation.',
            'Historical selectors refer only to resources discovered for this object. Truncated output is not a complete patch.'] };
      }
    }
  }
}
