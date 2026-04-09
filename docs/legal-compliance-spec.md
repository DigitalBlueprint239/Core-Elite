# Core Elite Combine Platform — Legal Compliance Specification
## FERPA / COPPA / SOC 2 Readiness

**Document Version:** 1.0  
**Effective Date:** April 8, 2026  
**Classification:** Confidential — For Legal, Compliance, and Institutional Review  
**Prepared By:** Core Elite Systems & Legal Affairs  
**Intended Audience:** General Counsel, League Commissioners, D1 Athletic Compliance Officers, Enterprise Licensing Due-Diligence Teams

---

## 1. Executive Summary

Core Elite operates a precision athletic performance data platform serving scholastic athletes ages 10–19 at organized combine and scouting events. The platform collects, stores, and transmits biometric performance data (sprint times, jump measurements, strength scores) and personally identifiable information (PII) for the purpose of athletic evaluation.

This document establishes the formal legal compliance framework governing three regulatory domains:

- **COPPA** (Children's Online Privacy Protection Act) — applicable to athletes under age 13
- **FERPA** (Family Educational Rights and Privacy Act) — applicable when the platform is deployed by or in connection with an educational institution
- **SOC 2 Type II** — the operational security standard required by D1 institutional partners prior to data sharing agreements

This specification is intended to satisfy the due-diligence requirements of institutional licensing negotiations and to serve as the governing reference for all future product and engineering decisions affecting athlete data.

---

## 2. COPPA Compliance: Athletes Under 13

### 2.1 Regulatory Basis

The Children's Online Privacy Protection Act (15 U.S.C. §§ 6501–6506) and the FTC's implementing rule (16 C.F.R. Part 312) require verifiable parental consent before collecting personal information from children under 13. Core Elite events routinely include athletes in the 10–12 age bracket.

### 2.2 Age Determination

Age is calculated at registration time from the athlete's declared date of birth. The registration RPC (`register_athlete_secure`) enforces a hard age gate of 10–19. The client performs a pre-submission age check with an identical formula:

```
age = floor((today - date_of_birth) / 365.25)
```

If `age < 13`, the registration workflow **automatically routes to the Enhanced Parental Consent flow** described below.

### 2.3 Enhanced Parental Consent UI Flow (Athletes Under 13)

The registration UI (`src/pages/Register.tsx`) must implement the following branching workflow for sub-13 athletes. Steps marked **[REQUIRED]** are mandatory for COPPA compliance.

```
Step 1 — Athlete Information
  Collect: first name, last name, date of birth, position
  If calculated age < 13 → set coppaRequired = true → proceed to Step 1A

Step 1A — COPPA Notice to Parent/Guardian [REQUIRED]
  Display, verbatim or substantially equivalent:
  ──────────────────────────────────────────────────────────────
  "This athlete is under 13 years of age. Under the Children's
  Online Privacy Protection Act (COPPA), we are required to
  obtain verifiable consent from a parent or legal guardian
  before collecting this athlete's personal information.

  Information collected includes: name, date of birth,
  position, and athletic performance measurements recorded
  at today's event. This information is used solely for
  athletic evaluation and recruiting purposes.

  We do not sell, share with advertisers, or use for
  behavioral targeting any information collected from
  athletes under 13.

  By continuing, the parent or legal guardian affirms they
  have read and agree to the Core Elite Privacy Policy and
  provide verifiable consent on behalf of the athlete."
  ──────────────────────────────────────────────────────────────
  Required fields: parent_first_name, parent_last_name [REQUIRED]
  (in addition to parent_phone and parent_email already collected)

Step 2 — Parent/Guardian Verification [REQUIRED]
  Display consent form to the parent/guardian physically present.
  Collect guardian signature on the digital waiver canvas.
  The waiver text must include the following additional clause
  for sub-13 athletes:
  ──────────────────────────────────────────────────────────────
  "I am the parent or legal guardian of the athlete named above.
  I provide verifiable parental consent under COPPA for Core Elite
  to collect, store, and use my child's personal information and
  athletic performance data as described in the Privacy Notice
  presented to me at registration."
  ──────────────────────────────────────────────────────────────

Step 3 — Consent Record Storage [REQUIRED]
  On successful registration, write to the `waivers` table:
    coppa_consent: true
    consent_given_by: 'parent_guardian'
    consenting_party_name: [parent_first_name + parent_last_name]
    consenting_party_phone: [parent_phone]
  The waiver record is immutable once written (append-only by RLS policy).

Step 4 — Receipt [REQUIRED]
  Send SMS receipt to parent_phone (or display on-screen if SMS
  integration is not yet deployed) confirming:
  "Core Elite has recorded your consent for [Athlete First Name]'s
  participation in today's combine. To request deletion of your
  child's data, contact privacy@coreelite.com."
```

### 2.4 Data Minimization

For athletes under 13, the following fields are **not** collected or stored:
- Profile photograph
- Social media handle
- School name (high school field is optional and not required for sub-13 athletes)
- Any behavioral or engagement analytics

### 2.5 Parental Right to Deletion

Upon written request from a verified parent or guardian, Core Elite will:
1. Soft-delete the athlete record (`deleted_at` timestamp, not a hard DELETE)
2. Void all associated result records (`voided = true`)
3. Retain the audit log and waiver record for 7 years (legal hold)
4. Confirm deletion within 45 days of verified request

The deletion request workflow is handled through `privacy@coreelite.com` pending implementation of a self-service portal (planned for Q3 2026).

---

## 3. FERPA Compliance: Institutional Deployments

### 3.1 Regulatory Basis

The Family Educational Rights and Privacy Act (20 U.S.C. § 1232g; 34 CFR Part 99) governs the privacy of student education records. When Core Elite is deployed by or contracted with an educational institution (e.g., a school district hosting a combine, or a university's athletic department evaluating prospects), athletic performance records may constitute "education records" under FERPA if they are:

- Directly related to a student, and
- Maintained by an educational agency or institution, or a party acting on its behalf

Core Elite's institutional contracts include a **School Official exception** designation under 34 C.F.R. § 99.31(a)(1), which permits disclosure of education records to a party acting on the institution's behalf under a formal agreement specifying legitimate educational interest.

### 3.2 FERPA Audit Logging — Database Schema

Every access to, or modification of, a student athlete's performance record must be logged in a write-once, append-only audit table. **Migration 013** already implements the foundational `audit_log` table. This section defines the complete authoritative schema for enterprise deployments.

```sql
-- Authoritative schema reference (implemented in migrations/013_audit_log.sql)
-- Reproduced here for institutional review.

CREATE TABLE IF NOT EXISTS audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who performed the action
  actor_id     UUID NOT NULL REFERENCES auth.users(id),
  actor_role   TEXT NOT NULL,           -- 'staff' | 'admin' | 'coach' | 'scout' | 'system'
  device_id    TEXT,                    -- station_id or browser fingerprint

  -- What was done
  action       TEXT NOT NULL,
  -- Enumerated values:
  --   'result_submitted'     — a performance result was recorded
  --   'result_voided'        — a result was marked void
  --   'athlete_registered'   — a new athlete record was created
  --   'athlete_viewed'       — a scout or coach viewed an athlete's record
  --   'athlete_exported'     — athlete data was included in a CSV export
  --   'band_claimed'         — an athlete claimed a wristband
  --   'band_voided'          — a wristband was voided
  --   'waiver_signed'        — a waiver/consent form was completed
  --   'override_applied'     — an admin override PIN was used
  --   'data_export'          — a bulk data export was generated

  -- What record was affected
  event_id     UUID REFERENCES events(id),
  target_type  TEXT NOT NULL,           -- 'result' | 'athlete' | 'band' | 'waiver' | 'export'
  target_id    UUID,                    -- the affected record's primary key
  target_data  JSONB,                   -- snapshot of relevant changed fields (before/after)

  -- When
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  hlc_timestamp TEXT,                   -- HLC for cross-device ordering

  -- Immutability enforcement
  -- No UPDATE or DELETE policy exists for this table.
  -- The trigger below enforces append-only at the database level.

  CONSTRAINT audit_log_action_check CHECK (action IN (
    'result_submitted', 'result_voided', 'athlete_registered',
    'athlete_viewed', 'athlete_exported', 'band_claimed', 'band_voided',
    'waiver_signed', 'override_applied', 'data_export'
  ))
);

-- Append-only enforcement trigger
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only. UPDATE and DELETE are not permitted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_audit_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- RLS: authenticated users can insert; only admins can select
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Audit insert — authenticated"
  ON audit_log FOR INSERT TO authenticated
  WITH CHECK (actor_id = auth.uid());

CREATE POLICY "Audit select — admin only"
  ON audit_log FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM staff_assignments
      WHERE staff_id = auth.uid() AND role IN ('admin', 'org_admin')
    )
  );
```

### 3.3 Scout and Coach Record Access Logging

When a coach or scout views an athlete's detailed profile in the Coach Portal (`src/pages/CoachPortal.tsx`), an `athlete_viewed` audit entry must be written. This is currently **not yet implemented** and is required before institutional deployment.

**Required implementation** (migration 016 or client-side):

```typescript
// Called in CoachPortal when an athlete row is expanded or a profile is opened
async function logAthleteView(athleteId: string, eventId: string) {
  await supabase.from('audit_log').insert({
    actor_id:    (await supabase.auth.getUser()).data.user!.id,
    actor_role:  'coach',
    action:      'athlete_viewed',
    event_id:    eventId,
    target_type: 'athlete',
    target_id:   athleteId,
    target_data: { viewed_at: new Date().toISOString() },
  });
}
```

Similarly, every `data_export` (ARMS CSV generation) must produce an audit record:

```typescript
// Called in CoachPortal's handleArmsExport
await supabase.from('audit_log').insert({
  actor_id:    currentUserId,
  actor_role:  'coach',
  action:      'data_export',
  event_id:    selectedEventId,
  target_type: 'export',
  target_id:   null,
  target_data: {
    format:        'ARMS_CSV',
    athlete_count: athletes.length,
    exported_at:   new Date().toISOString(),
    filename:      buildExportFilename(eventName),
  },
});
```

### 3.4 Data Retention and Disposal

| Record Type | Retention Period | Disposal Method |
|---|---|---|
| Athlete PII | 3 years from event date | Soft-delete + field nullification |
| Performance results | 7 years (recruiting eligibility window) | Voided; PII fields nullified after 3 years |
| Audit log entries | 7 years (minimum; indefinite preferred) | Never deleted |
| Waiver/consent records | 7 years | Never deleted |
| Parent contact information | Until deletion request or 3 years | Hard purge on verified request |

### 3.5 Data Sharing Restrictions

Under FERPA, education records may not be shared with third parties without explicit consent or a FERPA exception. The Core Elite platform enforces this through:

1. **Org-scoped RLS.** All `SELECT` queries on `athletes` and `results` are gated by `org_id`. A coach from University A cannot query athletes associated with University B's events.
2. **B2B export consent.** The ARMS CSV export is available only to authenticated staff with role `coach` or `admin`. Each export produces an audit record. The institutional agreement must specify that the receiving CRM (ARMS, JumpForward, XOS) is an authorized educational party under FERPA.
3. **No anonymous data sale.** Core Elite does not sell, license, or otherwise transfer performance data to any commercial third party without a separate signed data processing agreement.

---

## 4. SOC 2 Type II Readiness Checklist

SOC 2 Type II certification requires a third-party auditor to observe controls over a minimum 6-month period. The following checklist identifies the controls that must be verified and/or implemented before engaging an auditor.

### 4.1 Access Control (CC6.1 — CC6.3)

| Control | Status | Action Required |
|---|---|---|
| Multi-factor authentication for all admin accounts | **Required** | Enforce MFA in Supabase Auth settings for `admin` and `org_admin` roles |
| Role-based access control (RBAC) | Implemented | Verify `staff_assignments` table covers all role variants |
| Principle of least privilege on Supabase RLS | Implemented | Commission external RLS audit before first enterprise event |
| Service account credentials rotated quarterly | **Required** | Document rotation schedule; store secrets in Vercel environment (not `.env` files) |
| Session timeout for staff portal | **Required** | Implement 8-hour session expiry with re-authentication prompt |
| Admin access to production database requires VPN or IP allowlist | **Required** | Configure Supabase network restrictions |

### 4.2 Encryption (CC6.7)

| Control | Status | Action Required |
|---|---|---|
| Encryption in transit (TLS 1.2+) | Implemented | Supabase and Vercel enforce TLS. Verify no HTTP endpoints exist. |
| Encryption at rest — database | Implemented | Supabase (AWS RDS) encrypts at rest by default (AES-256) |
| Encryption at rest — client device | **Required** | OPFS (PowerSync storage) is not encrypted. Implement SQLCipher for React Native path; document as out-of-scope for browser-based deployment with appropriate risk acceptance. |
| Key management | **Required** | Document which team members hold Supabase service role key. Rotate immediately if any holder departs. |
| Supabase `anon` key treated as non-secret | Implemented | Correct — `anon` key is public. Verify no service role key is exposed in client-side code. |

### 4.3 Availability and Business Continuity (A1.1 — A1.3)

| Control | Status | Action Required |
|---|---|---|
| Offline-first operation during internet outage | Implemented | Documented in tech-spec-powersync.md |
| Database point-in-time recovery (PITR) | **Required** | Enable PITR on Supabase Pro plan (minimum 7-day recovery window) |
| Backup tested and documented | **Required** | Schedule quarterly backup restoration test; document results |
| Incident response plan | **Required** | Draft a written IRP identifying on-call contacts, escalation path, and SLA commitments |
| Uptime SLA for enterprise events | **Required** | Define and commit to SLA (recommend 99.5% during event windows) |

### 4.4 Change Management (CC8.1)

| Control | Status | Action Required |
|---|---|---|
| All schema changes via versioned migrations | Implemented | `migrations/` directory with sequential numbering |
| Pull request review required before merge to `main` | **Required** | Enforce branch protection rules in GitHub; require 1 approver |
| Migration tested on staging before production | **Required** | Create `staging` Supabase project; add migration CI step |
| Rollback procedure documented for each migration | **Required** | Add `-- ROLLBACK:` comment block to each migration file |

### 4.5 Monitoring and Logging (CC7.2)

| Control | Status | Action Required |
|---|---|---|
| Audit log for all data access and modification | Partially implemented | `athlete_viewed` and `data_export` log entries must be added (§3.3) |
| Log retention ≥ 1 year | **Required** | Configure Supabase log export to S3 or equivalent; default retention is 7 days |
| Alerting on failed authentication attempts | **Required** | Configure Supabase Auth anomaly detection; alert on > 5 failed logins/minute |
| Alerting on unusual data export volume | **Required** | Implement export volume threshold alert (e.g., > 500 athletes exported in a single session) |

### 4.6 Vendor Management (CC9.2)

| Vendor | Data Processed | DPA Required |
|---|---|---|
| Supabase | All PII, all performance data | ✅ Available — execute before first enterprise event |
| Vercel | No persistent PII (static hosting + edge) | ✅ DPA available on Vercel Enterprise |
| PowerSync (journeyapps.com) | Sync metadata; data transits but is not stored | **Required** — request DPA before go-live |
| ARMS / JumpForward / XOS (receiving CRM) | Exported CSV subset | **Required** — institutional agreement must name as authorized recipient |

---

## 5. Privacy Policy Requirements

A publicly accessible Privacy Policy must be published at `https://[domain]/privacy` before the first public event. It must include, at minimum:

1. **Data controller identity** — Core Elite legal entity name and contact information
2. **Categories of data collected** — PII, biometric performance data, device identifiers
3. **Purpose of collection** — athletic evaluation, recruiting facilitation, event operations
4. **Legal basis for processing** — consent (COPPA), legitimate interest (adult athletes), contractual (institutional deployments)
5. **Data retention periods** — as defined in §3.4
6. **Third-party data sharing** — list all recipients (ARMS, JumpForward, XOS, Supabase, Vercel)
7. **Parental rights under COPPA** — right to review, correct, and delete children's data
8. **Student rights under FERPA** — right to inspect and challenge records
9. **Contact for data requests** — `privacy@coreelite.com`
10. **Effective date and version history**

---

## 6. Implementation Priority Matrix

| Item | Priority | Blocking |
|---|---|---|
| COPPA sub-13 UI flow (§2.3) | **P0** | Any event with athletes under 13 |
| `athlete_viewed` audit logging (§3.3) | **P0** | Enterprise institutional deployment |
| `data_export` audit logging (§3.3) | **P0** | Enterprise institutional deployment |
| MFA enforcement for admin accounts (§4.1) | **P0** | SOC 2 audit initiation |
| Session timeout (§4.1) | **P1** | SOC 2 audit initiation |
| PITR enabled on Supabase (§4.3) | **P1** | Enterprise SLA commitment |
| Supabase DPA executed (§4.6) | **P1** | Any event |
| Privacy Policy published (§5) | **P1** | Any public event |
| Log retention pipeline (§4.5) | **P2** | SOC 2 Type II observation period start |
| Pull request branch protection (§4.4) | **P2** | SOC 2 Type II observation period start |
| Rollback blocks in migrations (§4.4) | **P2** | Engineering best practice |

---

## 7. Document Control

This document must be reviewed and re-approved by the Core Elite General Counsel (or designated compliance officer) prior to:
- Each major platform version release
- Any new institutional licensing agreement
- Any change to data retention periods, third-party data sharing arrangements, or collection scope
- Annual review cycle (minimum)

**Next scheduled review:** October 8, 2026

---

*Core Elite Combine Platform — Confidential. Not for distribution outside of authorized legal and institutional review contexts.*
