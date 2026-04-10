# Core Elite Combine Platform — Documentation Index

## Architecture Documents

| Document | Description |
|---|---|
| [`architecture/Core_Elite_Combine_Technical_Audit_2026-04-09.md`](architecture/Core_Elite_Combine_Technical_Audit_2026-04-09.md) | **Primary audit document.** Full architecture snapshot with verification map, source file traceability, and implementation details for all seven pillars. Start here. |
| [`architecture/Core_Elite_God_Tier_Framework.md`](architecture/Core_Elite_God_Tier_Framework.md) | Markdown summary of the God Tier Framework — seven pillars, validation gate thresholds, normative data status |
| [`architecture/Core_Elite_God_Tier_Framework.md.pdf`](architecture/Core_Elite_God_Tier_Framework.md.pdf) | Full PDF specification (BLE physics, normative sourcing methodology, Byzantine SQLite analysis) |
| [`architecture/tech-spec-powersync.md`](architecture/tech-spec-powersync.md) | PowerSync offline-first migration spec — WASM SQLite, service-worker sync, QR/NFC check-in, connector implementation |
| [`architecture/Core Elite — Tier-2 Deep Engineering Knowledge Corpus.md`](<architecture/Core%20Elite%20%E2%80%94%20Tier-2%20Deep%20Engineering%20Knowledge%20Corpus.md>) | BLE protocol stack, GATT architecture, normative data sourcing methodology |
| [`architecture/Core Elite — Tier-3 Execution Corpus  RF Physics, C++ Memory Limits & Byzantine SQLite.md`](<architecture/Core%20Elite%20%E2%80%94%20Tier-3%20Execution%20Corpus%20%20RF%20Physics%2C%20C%2B%2B%20Memory%20Limits%20%26%20Byzantine%20SQLite.md>) | RF timing constraints, C++ memory budget analysis, SQLite edge cases |
| [`architecture/Core Elite Football Combine App — AI Engineering Knowledge Corpus.md`](<architecture/Core%20Elite%20Football%20Combine%20App%20%E2%80%94%20AI%20Engineering%20Knowledge%20Corpus.md>) | AI-ingestible engineering knowledge corpus |

## Other Docs

| Document | Description |
|---|---|
| [`legal-compliance-spec.md`](legal-compliance-spec.md) | Legal and compliance specification (COPPA, data handling) |

## Quick Navigation for Auditors

**"Where is the offline sync implementation?"**
→ `src/lib/offline.ts`, `src/hooks/useOfflineSync.ts`

**"Where is the conflict resolution logic?"**
→ `src/lib/lww.ts`, `src/lib/hlc.ts`

**"Where is the scoring engine?"**
→ `src/lib/scoring/` (6 modules: bes, percentile, disparity, validation, constants, index)

**"Where are the database migrations?"**
→ `migrations/` — 16 migration files (002–016 + add_override_pin)

**"Where is the BLE native module?"**
→ `packages/native-ble/` (C++, iOS, Android, TypeScript)

**"Where is the PowerSync migration plan?"**
→ `docs/architecture/tech-spec-powersync.md` (canonical) and `tech-spec-powersync.md` (root copy)

**"Where is the full route tree?"**
→ `src/App.tsx`
