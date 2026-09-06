// PolicyEvaluator was removed 2026-08-20. It was an in-memory helper that
// answered "is this user a member of this org / does it hold this role" by
// scanning an array handed to it, it had no consumer anywhere in the repo, and
// its only test claimed in its title to prove row-level isolation. Authorization
// in TuGPT is enforced by RLS policies and SECURITY DEFINER RPCs in the
// database (ADR-004); the tests that prove it are supabase/tests/database/*.sql,
// which now run in CI. An exported helper with a security-sounding name and no
// call sites is a trap for whoever imports it next believing it is the
// enforcement point.
export * from './whatsapp-signature';
export * from './secret-crypto';
export * from './secret-store';
