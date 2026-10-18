# Atlas Platform Operations Handbook

> Deterministic ParaDoc fixture. Use targeted questions to verify that relevant sections are selected instead of returning this entire document.

**Document ID:** ATLAS-OPS-042  
**Version:** 4.7.2  
**Audience:** platform engineers, service owners, incident commanders, auditors  
**Classification:** internal engineering documentation

## How to test this document

Ask questions that target different regions:

- Which controls are required before a production deployment?
- What is the rollback procedure for the billing API?
- Compare the Bronze, Silver, and Gold service tiers.
- Which alerts indicate data loss rather than elevated latency?
- Find the retention policy for audit events.
- What should an incident commander do during a regional outage?

A correct focused answer should cite headings, preserve important numbers, and identify omitted ranges when exact text is required.

---

## 1. Platform overview

Atlas is a multi-region application platform for event-driven business services. It provides workload scheduling, service discovery, encrypted configuration, audit events, and policy-controlled data access.

The platform is divided into five planes:

| Plane | Responsibility | Availability target |
|---|---|---:|
| Control | configuration, identity, policy | 99.95% monthly |
| Runtime | workload scheduling and execution | 99.99% monthly |
| Data | queues, object storage, relational data | 99.99% monthly |
| Observability | metrics, logs, traces, alerts | 99.9% monthly |
| Recovery | backups, replication, restoration | RPO and RTO governed |

### 1.1 Design principles

1. Fail closed at trust boundaries.
2. Prefer idempotent operations over distributed transactions.
3. Make every asynchronous state transition observable.
4. Separate customer data from operational metadata.
5. Treat recovery as a production path, not a quarterly exercise.
6. Preserve evidence before attempting remediation.

### 1.2 Regions and cells

A region contains three or more cells. A cell contains independent compute, queue, and database capacity. Requests are routed to a home region, then to a healthy cell. Cross-region failover is controlled by the traffic director and never performed by application code.

A cell is considered degraded when any two of the following are true for five minutes: queue age exceeds 120 seconds, error rate exceeds 2%, database replica lag exceeds 30 seconds, or worker saturation exceeds 85%.

## 2. Service tier model

Services declare a tier in `service.yaml`. The tier determines deployment gates, replica minimums, backup frequency, and incident response expectations.

### 2.1 Bronze tier

Bronze services are internal or non-critical. They require two replicas, daily backups, and a 99.5% monthly availability target. A single-cell deployment is permitted for development environments only. Bronze services may use best-effort queues but must expose health and readiness endpoints.

### 2.2 Silver tier

Silver services support important internal workflows or customer-facing secondary features. They require three replicas across two cells, hourly backups, and a 99.9% monthly availability target. Deployments require automated rollback and a reviewed runbook.

### 2.3 Gold tier

Gold services support payments, identity, regulatory reporting, or primary customer workflows. They require six replicas across three cells, continuous replication, immutable audit events, and a 99.99% monthly availability target. Gold changes require an approved change record and an on-call owner.

| Property | Bronze | Silver | Gold |
|---|---:|---:|---:|
| Minimum replicas | 2 | 3 | 6 |
| Failure domains | 1 | 2 | 3 |
| Backup interval | 24h | 1h | continuous |
| Target availability | 99.5% | 99.9% | 99.99% |
| Maximum RTO | 24h | 4h | 30m |
| Maximum RPO | 24h | 1h | 5m |

## 3. Repository and ownership standards

Every service repository must contain `service.yaml`, `OWNERS`, `RUNBOOK.md`, and `CHANGELOG.md`. The owner group must have at least two active engineers and one escalation contact.

The `service.yaml` file declares `name`, `tier`, `runtime`, `dataClass`, `regions`, `dependencies`, and `alerts`. Unknown fields are rejected by CI. A service may not declare a dependency on a lower confidentiality data class without an approved exception.

The ownership file uses the following format:

```yaml
team: atlas-billing
primary: billing-oncall
secondary: platform-escalation
reviewers:
  - billing-lead
  - security-reviewers
```

Ownership transfers require a pull request, a two-week overlap, and a successful incident drill. Abandoned ownership is escalated to the platform council after seven days.

## 4. Deployment lifecycle

A deployment moves through `planned`, `built`, `verified`, `canary`, `progressive`, and `completed`. A failed transition moves the deployment to `blocked` or `rolled_back`; clients must never infer success from an absent status.

### 4.1 Preflight checks

Before building an artifact, CI validates dependency locks, secret references, migration compatibility, image provenance, license policy, and required reviewers. The build is rejected if the repository contains credentials, private keys, or generated files above the configured size limit.

### 4.2 Verification checks

The verification stage runs unit tests, contract tests, static analysis, container scanning, migration dry-runs, and a startup probe. Gold services additionally run a backup-restore smoke test and a cross-region dependency check.

### 4.3 Canary procedure

The canary receives one percent of traffic for ten minutes. Advance only if the canary error rate is below baseline plus 0.5 percentage points, p95 latency is below baseline plus 20 percent, and no critical alert is active. At five percent traffic, repeat the checks for fifteen minutes.

### 4.4 Progressive rollout

The default sequence is 1%, 5%, 25%, 50%, and 100%. The release controller pauses automatically when a monitored metric breaches its threshold. A human may resume only after documenting the observed cause and mitigation in the deployment record.

## 5. Deployment gates

| Gate | Owner | Required evidence | Failure action |
|---|---|---|---|
| G1 artifact | build | signed image digest | block |
| G2 policy | security | policy report | block |
| G3 migration | data | dry-run output | block |
| G4 canary | service owner | metric window | pause |
| G5 rollout | incident commander | approval record | pause |
| G6 completion | release bot | final health report | rollback |

A gate is valid only when its evidence references the same commit and artifact digest as the deployment. Screenshots without timestamps are advisory evidence only.

## 6. Rollback runbook

Rollback is preferred when the new version causes elevated errors, data corruption risk, dependency incompatibility, or a sustained saturation event. Do not rollback solely to hide an alert whose cause is unrelated to the deployment.

### 6.1 Standard rollback

1. Freeze progressive rollout.
2. Confirm the previous artifact digest is available.
3. Record the incident and deployment identifiers.
4. Shift traffic to the previous version.
5. Watch error rate, latency, queue age, and saturation for fifteen minutes.
6. Verify background workers have drained or been stopped safely.
7. Announce the rollback and assign a follow-up owner.

### 6.2 Database migration warning

A backward-incompatible migration must never be paired with an immediate application rollback. First determine whether the old application can read the new schema. If not, use the documented expand-migrate-contract sequence and involve the data owner.

### 6.3 Billing API rollback

For the billing API, disable new charge creation with the `billing.write.freeze` flag before traffic movement. Existing capture and refund operations remain enabled unless the incident commander declares a financial-integrity risk. Reconcile provider events after recovery and attach the reconciliation report to the incident.

## 7. Incident severity

### SEV-1 critical

Use SEV-1 for confirmed data loss, unauthorized access, widespread payment failure, or a complete regional outage. Page the incident commander, security lead, and executive liaison immediately. Establish a five-minute update cadence.

### SEV-2 major

Use SEV-2 for a material customer-impacting degradation, a high-value workflow failure, or a likely breach of the service objective. Establish a fifteen-minute update cadence and staff a communications owner.

### SEV-3 minor

Use SEV-3 for limited degradation, an internal-only failure, or a non-urgent control gap. The owning team manages the incident during business hours and records a follow-up issue.

| Severity | Initial page | Update cadence | Target mitigation |
|---|---:|---:|---:|
| SEV-1 | 5 minutes | 5 minutes | 30 minutes |
| SEV-2 | 15 minutes | 15 minutes | 4 hours |
| SEV-3 | 1 business day | 1 hour | 5 business days |

## 8. Incident commander checklist

The incident commander owns coordination, not every technical action. They should state the impact, establish the current hypothesis, assign workstreams, and prevent duplicate investigations.

During the first ten minutes:

- Name the incident and record the start time.
- Confirm the affected regions, services, and customer segments.
- Assign an operations lead, communications lead, and scribe.
- Freeze unrelated production changes.
- Choose the smallest reversible mitigation.
- Schedule the next update.

During stabilization, preserve logs and metrics before changing retention or sampling. Avoid destructive cleanup, broad restarts, and unreviewed configuration changes. If a hypothesis is disproved, record it rather than silently replacing it.

## 9. Alert catalogue

### 9.1 Error alerts

`AtlasRequestErrorRateHigh` fires when five-minute server errors exceed 2% and the request count exceeds 1,000. `AtlasDependencyFailure` fires when a dependency returns errors for three consecutive windows. These alerts indicate availability risk but not necessarily data loss.

### 9.2 Data integrity alerts

`AtlasWriteReconciliationGap` fires when accepted writes differ from committed records by more than 0.1% over ten minutes. `AtlasAuditSequenceGap` fires when a partition has a missing sequence number. These alerts require the data owner and should be treated as potential integrity incidents.

### 9.3 Saturation alerts

`AtlasQueueAgeHigh` fires at 120 seconds for Silver and 60 seconds for Gold. `AtlasWorkerSaturation` fires at 85% for ten minutes. Saturation alerts require capacity analysis before restarts because restarting workers can increase queue age.

## 10. Observability standards

Every request should carry a trace ID, request ID, tenant hash, deployment ID, and region. Never log access tokens, full payment identifiers, raw passwords, private keys, or unrestricted customer payloads.

Metrics use lowercase names and stable dimensions. Avoid user IDs, request IDs, and arbitrary exception text as metric labels. A metric with more than 100 distinct values in one hour requires review.

```text
atlas_request_duration_seconds{service,route,status_class,region}
atlas_requests_total{service,route,status_class,region}
atlas_queue_age_seconds{service,queue,region}
atlas_reconciliation_gap_total{service,stream,region}
```

Logs are retained for fourteen days in the hot tier and ninety days in the archive tier. Gold audit events are retained for seven years under the compliance policy.

## 11. Data classification

### Public

Public data may be distributed without access controls. Examples include published API documentation, release notes, and public status messages.

### Internal

Internal data is intended for employees and approved contractors. Examples include architecture diagrams, non-sensitive dashboards, and operational procedures.

### Confidential

Confidential data includes customer metadata, unreleased financial information, security findings, and detailed topology. Access requires group membership and is logged.

### Restricted

Restricted data includes payment credentials, identity documents, encryption keys, and incident evidence involving suspected compromise. Restricted data requires explicit authorization and must not be copied into tickets or chat.

## 12. Access control

Atlas uses short-lived workload identity and role-based access control. Human access is granted through groups, expires automatically, and requires multi-factor authentication. Service accounts may not use shared static credentials.

A role must be scoped to the smallest resource set and action set needed. Read and write permissions are separate. Break-glass access expires after sixty minutes and requires a justification, an approver, and a post-access review.

The quarterly access review checks inactive users, orphaned service accounts, privilege escalation paths, and role bindings outside approved regions. Findings are assigned to owners and tracked until closure.

## 13. Secret management

Secrets are stored in the managed vault and referenced by versioned name. Applications receive secrets at runtime through workload identity. Secrets must not be placed in source control, container layers, build logs, issue comments, or generated documentation.

Rotate a secret immediately when exposure is suspected. Preserve the audit record, revoke the old version, issue a replacement, restart dependent workloads, and verify that no old version remains in active use.

A secret reference failure should prevent startup for Gold services. Bronze services may start in a degraded mode only when the missing secret is demonstrably optional.

## 14. Backup and restore

Backups are encrypted with a platform-managed key and stored in a separate account. Backup jobs record source, timestamp, size, checksum, encryption key version, and retention expiry.

A restore test must verify that the recovered data is readable, consistent, and isolated from production. Merely confirming that a backup file exists does not constitute a restore test.

| Data class | Frequency | Retention | Restore target |
|---|---:|---:|---:|
| configuration | 6h | 180d | 4h |
| relational Gold | continuous plus daily | 7y | 30m |
| relational Silver | hourly | 365d | 4h |
| object data | daily | policy-based | 24h |
| audit events | continuous | 7y | 1h |

## 15. Disaster recovery

The recovery coordinator declares a regional disaster after confirming that restoration in place is not likely within the service tier RTO. The coordinator selects the target region, validates capacity, and authorizes traffic movement.

Recovery order is identity, configuration, data plane, critical queues, Gold services, Silver services, then Bronze services. Do not start dependent services before their data stores and authorization systems are healthy.

After recovery, compare event offsets, audit sequences, customer-visible state, and external provider state. Reconciliation is mandatory before declaring the incident resolved.

## 16. Queue and worker operations

Queues use at-least-once delivery. Consumers must be idempotent and must persist a deduplication key before producing an irreversible side effect. Poison messages move to a quarantine queue after five attempts.

A quarantine queue may be replayed only after the failure cause is known. Replay uses a bounded batch, a dry-run when available, and a separate metric namespace. Never delete quarantine messages as a substitute for investigation.

Workers should stop accepting new messages before shutdown and finish or safely release in-flight work. A forced termination is recorded as an interrupted operation.

## 17. API compatibility

Public APIs use semantic versioning and explicit deprecation windows. Additive fields are preferred. Removing or changing field meaning requires a major version or a compatibility plan approved by the API council.

Clients must tolerate unknown response fields and preserve correlation identifiers. Servers must reject malformed input with a stable error code, a safe message, and a trace ID.

```json
{
  "error": {
    "code": "invalid_argument",
    "message": "The requested limit is outside the allowed range.",
    "traceId": "truncated-in-example"
  }
}
```

## 18. Rate limits and quotas

Rate limits are applied per tenant, credential, route, and region. A rejected request returns `429` with a bounded retry hint. Clients must use exponential backoff with jitter and must not retry non-idempotent operations without an idempotency key.

Default limits are 600 requests per minute for interactive APIs, 60 requests per minute for administrative APIs, and 10 concurrent exports per tenant. Gold tenants may receive approved limits after capacity review.

## 19. Change management

A change record includes intent, risk, affected services, rollout plan, rollback plan, validation evidence, owner, and maintenance window. Emergency changes require a retrospective within two business days.

Changes to identity, payment, audit, routing, or backup systems require security review. Changes that alter customer data retention require compliance review. Changes without an owner are blocked automatically.

## 20. Testing strategy

Unit tests validate pure policy and transformation logic. Contract tests validate boundaries between services. Integration tests use ephemeral dependencies. End-to-end tests validate a customer workflow across regions and failure modes.

Every new asynchronous path needs a success test, a timeout test, a malformed-input test, an authorization test, and a retry or duplicate-delivery test. Tests must assert observable state transitions rather than only final output.

## 21. Performance budgets

The interactive API budget is 200 ms p50 and 800 ms p95 at the service boundary. Background jobs must expose throughput, queue age, and completion latency. A performance regression is actionable when it exceeds ten percent for two consecutive benchmark runs.

Memory growth is investigated when resident memory increases by more than twenty percent during a fixed workload. Large document processing must enforce byte, page, line, and elapsed-time limits before invoking a model.

## 22. Security review checklist

- Are all external inputs length-limited?
- Are URLs validated against the allowed scheme and redirect policy?
- Are archive and document expansion ratios bounded?
- Are secrets excluded from logs and error messages?
- Are untrusted instructions separated from system and user instructions?
- Are temporary files deleted after processing?
- Are permissions checked before reading protected data?
- Is the failure mode safer than the success mode?

## 23. Compliance evidence

Compliance evidence is stored with a control ID, scope, collection time, source revision, and reviewer. Evidence must be reproducible and must not contain unnecessary customer data.

The quarterly evidence package includes access reviews, backup restore results, vulnerability reports, deployment approvals, incident summaries, and retention checks. Missing evidence is recorded as a control exception rather than backfilled without explanation.

## 24. Runbook: unhealthy deployment

If a deployment is unhealthy, first determine whether the issue is isolated to the new version. Compare the canary and baseline by region, route, status class, and dependency. Check configuration and migration status before restarting workloads.

If rollback is safe, freeze the rollout and execute the standard rollback. If rollback is unsafe because of schema changes, stop writes where necessary and invoke the migration recovery plan. Keep the incident channel updated with timestamps and evidence.

## 25. Runbook: elevated queue age

Confirm whether producers increased traffic, consumers lost capacity, or a dependency slowed processing. Inspect oldest-message age, consumer error rate, worker saturation, retry count, and quarantine volume.

Do not simply increase concurrency if the downstream dependency is saturated. Apply backpressure, restore healthy consumers, or redirect traffic according to the service runbook. Record the chosen mitigation and expected recovery curve.

## 26. Runbook: suspected data integrity issue

Stop irreversible writes if the integrity alert is confirmed. Preserve database snapshots, event offsets, reconciliation reports, and deployment metadata. Assign a data owner and security observer.

Compare source events with committed records and downstream projections. Do not manually edit customer records until the correction method is reviewed and auditable. Resolution requires a reconciliation result and an approved customer-communication decision.

## 27. Runbook: credential exposure

Revoke the exposed credential, identify its scope, inspect access logs, and rotate dependent credentials. Preserve evidence before deleting temporary files or changing the affected workload.

Security determines whether notification, containment, or forensic preservation is required. Application teams must not classify an exposure as harmless solely because no misuse is visible in the first log search.

## 28. Glossary

**Artifact digest:** immutable cryptographic identifier for a built deployment artifact.

**Cell:** independent operational failure domain inside a region.

**Control plane:** systems that manage configuration, identity, and policy.

**Data plane:** systems that process customer or business data.

**RPO:** maximum acceptable amount of data loss measured in time.

**RTO:** maximum acceptable time to restore service.

**Quarantine queue:** isolated queue for messages that repeatedly fail processing.

**Break-glass access:** temporary elevated access granted for urgent recovery.

## 29. Decision records

### ADR-001: Multi-cell Gold deployment

**Decision:** Gold services must span three cells.  
**Reason:** A single cell does not provide sufficient isolation for the target availability.  
**Consequence:** Capacity and deployment automation must support three-cell placement.

### ADR-002: At-least-once queue delivery

**Decision:** Platform queues provide at-least-once delivery.  
**Reason:** Durable delivery is prioritized over exactly-once coordination across independent systems.  
**Consequence:** Every consumer must implement idempotency and deduplication.

### ADR-003: Immutable audit events

**Decision:** Audit events are append-only and retained for seven years.  
**Reason:** Investigations and compliance reviews require trustworthy historical evidence.  
**Consequence:** Corrections are represented as compensating events, never destructive edits.

## 30. Appendix: sample service manifest

```yaml
name: atlas-billing
team: atlas-billing
tier: gold
runtime: node20
dataClass: restricted
regions:
  - us-east
  - eu-west
dependencies:
  - identity
  - ledger
  - payment-provider
alerts:
  - AtlasRequestErrorRateHigh
  - AtlasWriteReconciliationGap
backup:
  rpo: 5m
  rto: 30m
```

## 31. Appendix: escalation matrix

| Situation | Primary | Secondary | Executive notification |
|---|---|---|---|
| payment integrity | billing on-call | security | yes |
| regional outage | incident commander | traffic operations | yes |
| queue backlog | service owner | capacity team | no |
| credential exposure | security on-call | service owner | depends on scope |
| audit gap | compliance owner | data platform | yes |

## 32. Appendix: final validation checklist

Before closing an operational change, confirm the artifact digest, deployment status, alert state, customer impact, rollback readiness, audit record, and follow-up owner. Confirm that every temporary flag has an expiry and every exception has an approver.

The final report should state what happened, when it happened, how it was detected, what was changed, what evidence supports the conclusion, and what remains uncertain. A concise report with durable evidence is preferred to a long report without reproducible facts.

## 33. Controlled vocabulary for test questions

Use these terms to test semantic retrieval: **billing API**, **Gold tier**, **audit sequence gap**, **regional disaster**, **quarantine queue**, **break-glass**, **RPO**, **RTO**, **canary**, **restricted data**, **credential exposure**, **migration rollback**, **queue age**, **immutable audit**, **three cells**, and **seven years**.

## 34. End marker

This marker should be easy to locate with an explicit ranged read:

`ATLAS_FIXTURE_END = 34`
