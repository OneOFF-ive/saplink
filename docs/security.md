# Security Notes

## Release checks

`saplink update check` uses the public COS manifest by default without automatic GitHub fallback; GitHub is queried only when explicitly configured. Running UI and service processes also check asynchronously after startup and every hour, bypassing the CLI metadata cache. Set `SAPLINK_AUTO_UPDATE_CHECK=0` before restarting to disable automatic checks; no OS scheduled task is installed. Requests send no SAP credentials, MCP tokens, connection configuration or query data. The selected update hosts receive ordinary network request metadata. Each source request uses an 8-second timeout, bounds metadata to 256 KiB and rejects redirects. Release metadata is cached separately for 24 hours and cache write failure does not invalidate a successful network check. Automatic failures remain quiet and do not interrupt SAP operations; results in the management API require its existing authentication.

The command reports a validated HTTPS GitHub release-page URL, version metadata and optional mirror downloads with SHA-256 values. Mirror downloads must match the configured HTTPS manifest origin, version directory, architecture and standard installer filename. `SAPLINK_UPDATE_URL` selects a custom HTTPS manifest, or `github` disables the mirror; only an operator should change this trust source. Cache entries are scoped to that manifest URL, and old-format entries are refreshed. Checks are priority failover, not a comparison of all sources; the publisher must keep the mirror current. A hash served by the same host as a binary does not independently authenticate the publisher. It does not download, execute, install or verify release binaries, and does not establish publisher authenticity or installer integrity. Installation and signature/hash checks remain separate. A missing public release, network failure or rate limit must not be reported as proof that the installation is up to date.

## AI lifecycle CLI (2026-10-16)

The lifecycle manager serializes its commands with a separate lease and uses the existing runtime/config leases. Read-only lease inspection never reclaims locks. A managed instance is identified by PID, process start time via its runtime lease, a lease nonce and an authenticated control response. Stop uses a dedicated loopback control listener, requires a separate random token, rejects Origin and unexpected Host, and never kills a PID. This listener is not exposed as an MCP tool. Its metadata file contains a control secret and must remain private to the current OS user; mode 0600 is requested, and Windows access control still depends on directory ACLs. Treat custom configuration directories as sensitive.

JSON CLI output excludes credentials and control tokens. `token create --out` and `client-config --out` create new local secret files without overwriting; do not commit, share or print them. Status/doctor do not return their contents. A Windows password dialog sends input only through an internal process pipe to the credential-store writer, never through CLI options or environment variables. A changed login identity requires fresh password entry. Client instructions alone cannot constrain a terminal-capable AI: that client still acts with the local user's OS permissions.

Background startup includes a TCP listener preflight and still handles actual bind failures; this is not an atomic port reservation. Shutdown waits for normal request/session cleanup. Timeout means uncertainty, not permission to force-kill or retry writes. Background mode does not install an OS service or guarantee crash/reboot recovery. Existing foreground service/UI instances remain outside managed stop/restart.

## Review and fixes (2026-10-15)

The local management API authentication guard now matches paths case-insensitively, consistent with Express routing. Previously uppercase paths such as `/API/state` bypassed the lowercase `/api/` middleware check; management mutations including token creation could also bypass that guard. Regression tests enforce authentication and same-origin checks across mixed-case paths. Restart all old processes to apply the fix; it is not a change to already running services.

The SELECT guard now rejects both `CLIENT` and `CLIENTS` outside quoted values, including `USING ALL CLIENTS`, `USING CLIENTS IN` and nested queries. Previously the plural form could bypass the configured-Client policy, subject to SAP backend support and authorization.

MCP initialization provides client instructions for data handling and safe write recovery. Parameter descriptions explain identifiers, filters and revision/request IDs. Tool arguments are limited to 2000 combined object members/array elements before schema validation. Client instructions are guidance, not an enforcement boundary; server validation and SAP authorizations remain required.

## Backend transport and access scope

Backend connections accept HTTP and HTTPS. Prefer HTTPS with a trusted server certificate; the bounded Axios client uses default TLS verification, forbids cross-origin requests and never follows redirects, including HTTPS-to-HTTP redirects. No insecure-certificate switch or automatic downgrade is provided. Existing HTTP connections remain compatible and still send authentication and data without transport encryption. HTTPS has not been validated against a live SAP system in this review.

All valid MCP tokens share configured connections and SAP-user privileges; there is no per-token system, table or row-level policy. Keep SAP users appropriately scoped. Query row limits do not bound database scan cost, and read operations may recreate a cached session and retry once. Enhancement version probes cannot establish BAdI/CMOD runtime enablement.

## Data Queries

`query_table` and `query_sql` use stateless SAP Data Preview requests and do not require `write_enabled`. The table tool validates identifiers and escapes string literals; the SQL tool conservatively accepts SELECT with FROM and rejects mutations, comments, statement terminators, INTO, client overrides, external connections and privileged access. SAP still controls syntax, entity visibility and authorizations. Queries use the configured Client and never acquire editor locks. Returned rows default to 100 and are capped at 500, with one extra row requested to detect truncation. This does not cap database scan cost. HTTP requests retain the 15-second timeout and 4 MiB response bound; timeout does not guarantee server-side cancellation. Query text, filter values and results are not added to application audit logs or the write-request cache. Raw string results preserve identifiers and numeric precision. Discovery advertisement is reported separately for DDIC and freestyle and does not establish authorization or confirmed availability.

## Local Lease Protection

Runtime and configuration lease operations use an exclusive `.guard` file to serialize stale-owner inspection, removal, creation and release. The guard is held only during these filesystem operations, not throughout the MCP service lifetime. Concurrent attempts fail closed and may be retried after the current command finishes.

The guard is deliberately never reclaimed automatically. If a process terminates while it holds a guard, stop all SapLink service and configuration processes, verify none is still running, then remove only the reported `runtime.lock.guard` or `config.lock.guard` from the configuration directory. Do not remove guards while another process may be modifying the configuration. Ordinary stale lease files still use process identity checks, under the guard.

All concurrent processes must run this guarded implementation. Stop older versions before upgrading; an older process does not honor the new guard. The protection assumes that other applications do not tamper with this user's configuration directory.

## Dependency Advisory

The upstream `abap-adt-api` dependency requests `sprintf-js@^1.1.3`, affected by [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). The advisory concerns attacker-controlled numeric precision in format strings. No patched upstream release is listed as of 2026-10-18. SapLink's reviewed ADT paths use only fixed formats with at most one `%s`; no externally controlled format string was found in those calls.

SapLink now overrides that transitive dependency with the project-owned `vendor/adt-path-format` module. It implements only bounded `%s` string substitution and `%%`, rejecting numeric precision, padding and named directives before processing arguments. It does not contain the upstream numeric formatter. Regression tests exercise the actual ADT dependency resolution, all registered creation formats and malicious precision inputs. Review this restricted API contract whenever upgrading `abap-adt-api`.

The lockfile installs the local module under the expected `sprintf-js` import name. Project npm configuration enables `install-links`; Windows staging copies `vendor/` before `npm ci --install-links`, so installations contain ordinary files rather than runtime links to a developer checkout. Do not remove the override or vendor directory without an equivalent fix. The full npm dependency audit reported zero known vulnerabilities on 2026-10-18; this is a point-in-time dependency result, not proof that the application has no security flaws. No dependency downgrade or broad dependency upgrade was used.

## Confirmed automatic installation

`update check` remains read-only. `update install --yes` and the management UI's explicit update confirmation can download and run the installed architecture's COS installer. The endpoint accepts only a version, rechecks the trusted manifest and validates the download against its SHA-256. Requests carry no SAP or MCP credentials, reject redirects, cap downloads at 256 MiB, and never execute a partially downloaded file. SHA-256 from the same publishing origin does not provide independent publisher authentication.

The Windows-only runner verifies the registered install root and product/version resources, waits for graceful shutdown, uses a hidden independent process, installs in the original per-user directory, and verifies the resulting manifest. It never force-kills a process or deletes a runtime lock. There is no guaranteed rollback if the installer partially fails. A persistent per-configuration pending marker prevents duplicate tasks; an installer timeout retains that marker for inspection. CLI handoff is not proof of successful installation; final state is recorded in `update-install-result.json`. Configuration and credentials are retained, and restart follows the previous UI/service/stopped mode.


## ATC and ABAP Unit execution

`run_atc` and `run_unit_tests` are execution tools: they require the connection write switch, explicit user execution authorization, `confirm_execution=true` and a unique process-local request ID. They cannot target packages or arbitrary endpoints. ATC creates analysis artifacts; Unit executes backend code. Unit selection is HARMLESS only and defaults to SHORT; these SAP labels are not a sandbox guarantee. There is no source save, activation, automatic test execution or unconfirmed retry.

The analysis HTTP session is isolated from the editing session and disables the ADT client's login-error replay. An unknown or interrupted run must be investigated before any fresh request. Audit failure blocks dispatch. Version comparisons follow only discovered same-origin ADT history resources without Client overrides, bind selectors to the connection/object and bound both computation and output. Read/compare operations do not restore source.
