import type { OrganizationLocale } from './locales';

export type OrganizationRole = 'owner' | 'admin' | 'manager' | 'agent' | 'viewer';
export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'revoked';

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  /**
   * Reserved for a future per-user override. Nothing reads it — the dashboard
   * resolves language from `Organization.locale` (ADR-017). Constrained in the
   * database as of 20260830000001, so this union is now enforced rather than
   * merely asserted.
   */
  preferred_locale: OrganizationLocale;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  /** Language the dashboard renders in for this organization. See ADR-017. */
  locale: OrganizationLocale;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface OrganizationMember {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
  created_at: string;
  updated_at: string;
}

export interface OrganizationInvitation {
  id: string;
  organization_id: string;
  /** Always stored lowercased and trimmed by `create_invitation`. */
  email: string;
  role: OrganizationRole;
  /**
   * SHA-256 of the token, hex. Never the token itself, and never presentable:
   * `accept_invitation` hashes what it is given, so sending this value back
   * does not accept the invitation (20260902000001).
   */
  token_hash: string;
  status: InvitationStatus;
  invited_by: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: string;
  organization_id: string;
  user_id: string | null;
  action: string;
  resource: string;
  details: Record<string, unknown>;
  ip_address: string | null;
  created_at: string;
}

export interface FeatureFlag {
  id: string;
  organization_id: string | null;
  key: string;
  is_enabled: boolean;
  rules: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Phase 3B types

export interface AiDraftConfig {
  id: string;
  organization_id: string;
  business_profile_id: string;
  business_instructions: string;
  personality: string;
  response_rules: string;
  tone: string;
  max_draft_length: number;
  created_at: string;
  updated_at: string;
}

export interface AiDraft {
  id: string;
  organization_id: string;
  business_profile_id: string;
  conversation_id: string;
  source_message_id: string;
  current_revision_id: string | null;
  status: 'draft' | 'approved' | 'rejected';
  version: number;
  provider: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
}

export interface AiDraftRevision {
  id: string;
  organization_id: string;
  draft_id: string;
  version: number;
  body: string;
  created_by_type: 'system' | 'user';
  created_by_user_id: string | null;
  created_at: string;
}

export interface AiDraftReviewEvent {
  id: string;
  organization_id: string;
  draft_id: string;
  action: 'approve' | 'edit' | 'reject';
  actor_id: string;
  previous_version: number;
  new_version: number;
  created_at: string;
}

export interface DraftGenerationJob {
  id: string;
  organization_id: string;
  business_profile_id: string;
  conversation_id: string;
  source_message_id: string;
  draft_id: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'archived';
  provider: string | null;
  model: string | null;
  attempt_count: number;
  error_code: string | null;
  pgmq_msg_id: string;
  created_at: string;
  updated_at: string;
}

export interface DraftQuotaLimit {
  id: string;
  organization_id: string;
  period_start: string;
  period_end: string;
  hard_ceiling: number;
  created_at: string;
  updated_at: string;
}

export interface DraftUsageTracking {
  id: string;
  organization_id: string;
  quota_limit_id: string;
  period_start: string;
  period_end: string;
  draft_count: number;
  reserved_count: number;
  created_at: string;
  updated_at: string;
}

export interface DraftUsageReservation {
  id: string;
  organization_id: string;
  draft_generation_job_id: string;
  quota_limit_id: string | null;
  status: 'reserved' | 'consumed' | 'released';
  created_at: string;
  updated_at: string;
}

// Phase 3A types

export interface BusinessProfile {
  id: string;
  organization_id: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}

export interface WhatsAppConnection {
  id: string;
  organization_id: string;
  business_profile_id: string;
  display_name: string | null;
  phone_number: string;
  provider_phone_number_id: string;
  status: 'pending' | 'active' | 'disconnected' | 'error';
  created_at: string;
  updated_at: string;
}

export interface WebhookEvent {
  id: string;
  organization_id: string;
  whatsapp_connection_id: string;
  provider: string;
  provider_event_key: string;
  event_kind: string;
  payload_sha256: string;
  status: 'received' | 'processed' | 'failed';
  received_at: string;
  processed_at: string | null;
  attempt_count: number;
  last_error_code: string | null;
}

export interface InboundMessageStaging {
  id: string;
  webhook_event_id: string;
  provider_message_id: string;
  contact_identifier: string;
  message_kind: string;
  body_text: string | null;
  provider_timestamp: string | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  organization_id: string;
  whatsapp_connection_id: string;
  contact_phone: string;
  status: 'open' | 'needs_human' | 'closed';
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  /**
   * `COALESCE(last_message_at, created_at)`, generated and STORED. Read-only —
   * the database rejects any attempt to write it (migration 20260901000001).
   *
   * Order inbox-style lists on this, never on `last_message_at`: that column is
   * nullable, DESC implies NULLS FIRST, and its only producer copies a nullable
   * unvalidated `provider_timestamp` into it — so a conversation whose webhook
   * carried no readable timestamp sorts above every recent one.
   */
  activity_at: string;
  /**
   * The reviewer who has claimed this conversation, or `null` for unclaimed.
   *
   * Writable only through `assign_conversation` (migration 20260901000002),
   * which locks the row and compare-and-sets against the assignee the caller
   * says they saw. Do not update it directly: a plain UPDATE cannot tell a
   * deliberate handover from two reviewers racing on the same stale screen.
   *
   * `ON DELETE SET NULL` — an erased reviewer releases their conversations
   * rather than blocking their own erasure. The record of who held it and when
   * survives in `conversation_events`.
   */
  assigned_to: string | null;
  /**
   * The {@link Contact} this thread is with. Non-null and maintained by the
   * database: a trigger sets it from `(organization_id, contact_phone)` on
   * insert, follows a change to `contact_phone`, and rejects (SQLSTATE
   * `P3E02`) any attempt to point a conversation at a different contact
   * (migration 20260902000002).
   *
   * `contact_phone` above is the same fact and is kept for its existing
   * readers. Prefer joining through this column in new code — the phone column
   * is scheduled to go once those readers move.
   */
  contact_id: string;
}

/**
 * One change to who is handling a conversation, or to whether the AI is
 * drafting for it.
 *
 * A separate table rather than a row in `audit_logs`: ADR-009 fixes that table
 * at exactly two writers, and the evidence pack reads it expecting only those.
 * The status column answers "what is it now"; this answers "who turned the AI
 * off for this customer, and when" — which a column can never answer, because
 * the previous value is gone the moment it is overwritten.
 *
 * Append-only in practice: `service_role` holds SELECT and INSERT, nothing
 * holds UPDATE or DELETE.
 */
export interface ConversationEvent {
  id: string;
  organization_id: string;
  conversation_id: string;
  action: 'assign' | 'unassign' | 'handoff' | 'return_to_ai';
  /** The reviewer who acted. NULL once that profile is erased. */
  actor_id: string | null;
  /** Who the conversation was assigned to, for `assign`. NULL otherwise. */
  subject_id: string | null;
  previous_status: string;
  new_status: string;
  created_at: string;
}

/**
 * A credential, encrypted by the application.
 *
 * The database holds ciphertext and no key — see migration 20260903000003 for
 * why the pgcrypto-in-database alternatives were rejected. Nothing in the app
 * reads these rows directly; `@tugpt/security`'s `decryptSecret` does, and
 * only `service_role` can reach them.
 */
interface EncryptedSecretColumns {
  /** Always `'aes-256-gcm'` today. Present so old rows say what encrypted them. */
  algorithm: 'aes-256-gcm';
  /**
   * Which key encrypted this row. The single most important column here:
   * rotation means finding the rows still on the retired key, and a store that
   * cannot answer that can never retire one.
   */
  key_id: string;
  /** 12 bytes. A fresh random nonce per encryption; reuse under one key is fatal. */
  iv: string;
  ciphertext: string;
  /** 16 bytes. The full GCM tag — truncating it weakens forgery resistance. */
  auth_tag: string;
}

/** TuGPT's own vendor credentials. Belongs to no organization. */
export interface PlatformSecret extends EncryptedSecretColumns {
  id: string;
  provider: string;
  secret_name: string;
  created_at: string;
  updated_at: string;
}

/**
 * A customer's connected account.
 *
 * A separate table from {@link PlatformSecret} rather than one table with a
 * nullable `organization_id`: the usual RLS predicate evaluates to NULL for
 * platform rows and excludes them by accident rather than by intent, and
 * security that works by accident works until someone writes the policy the
 * other way round.
 */
export interface OrganizationSecret extends EncryptedSecretColumns {
  id: string;
  organization_id: string;
  provider: string;
  secret_name: string;
  /** ADR-015 D8. Empty array, never null — "none" and "unknown" differ. */
  scopes: string[];
  /** `null` for credentials that do not expire, such as API keys. */
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One row of `public.organization_connected_accounts(organization_id)`.
 *
 * Metadata only. Deliberately carries no `ciphertext`, `iv`, `auth_tag` or
 * `key_id` — the last of those would tell a caller which key to go after.
 */
export interface ConnectedAccount {
  provider: string;
  secret_name: string;
  scopes: string[];
  expires_at: string | null;
  is_expired: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * An effective-dated provider rate.
 *
 * Prices live in a table rather than configuration because the rate is copied
 * onto the usage row at write time — history stays immutable, but the *current*
 * rate still has to come from somewhere auditable. A rate in an environment
 * variable is a number nobody reviewed and nobody can diff.
 */
export interface ProviderPrice {
  id: string;
  provider: string;
  /** `null` means "any model from this provider". An exact match outranks it. */
  model: string | null;
  dimension: 'input_tokens' | 'output_tokens' | 'audio_seconds';
  /** Price for one unit, as a decimal string — `NUMERIC(20,10)` in the database. */
  unit_price: string;
  currency: 'USD';
  effective_from: string;
  /** `null` means still in effect. */
  effective_to: string | null;
  /** Where the number came from. A price with no provenance cannot be re-verified. */
  source: string;
  created_at: string;
  updated_at: string;
}

/**
 * One provider call: what it was, and what it cost.
 *
 * @see ProviderUsageComponent for the per-dimension breakdown. An event's
 * `cost_micros` is required to equal the sum of its components', enforced by a
 * deferred constraint trigger — a total nobody can reconstruct cannot be
 * defended in a billing dispute.
 */
export interface ProviderUsageEvent {
  id: string;
  organization_id: string;
  occurred_at: string;
  modality: 'text' | 'audio';
  /** As *reported* by the adapter. Under rotation this is not the model asked for. */
  provider: string;
  model: string | null;
  /** The provider's own id for the call — what an invoice line reconciles against. */
  provider_reference: string | null;
  request_id: string | null;
  draft_generation_job_id: string | null;
  message_id: string | null;
  currency: 'USD';
  /**
   * Micro-units of currency, and **nullable**.
   *
   * Micro rather than cents because a 15-second voice note costs ~2,542 µUSD,
   * which cents would round to zero. Nullable because a call with no price in
   * the book is recorded with an unknown cost rather than dropped or valued at
   * zero — the provider will charge for it either way, so losing the row
   * destroys the only evidence it happened, and a zero silently under-reports
   * the organization's spend to the entitlement meter.
   */
  cost_micros: number | null;
  /**
   * Small, and never customer content. For audio this carries `audio_duration`
   * beside a billed `audio_seconds` component, so the difference between what
   * was measured and what was billed stays visible.
   */
  metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * One billed dimension of a {@link ProviderUsageEvent}.
 *
 * A separate table rather than columns on the event, because a text call bills
 * input and output at *different* rates and one row cannot carry one price.
 */
export interface ProviderUsageComponent {
  id: string;
  event_id: string;
  dimension: 'input_tokens' | 'output_tokens' | 'audio_seconds';
  quantity: number;
  /**
   * The rate at the time of the call, copied onto the row. Joining to
   * {@link ProviderPrice} instead would re-price history every time a vendor
   * changed rates, and last month's invoice would stop reconciling.
   *
   * `null` together with `cost_micros` when no price was known.
   */
  unit_price: string | null;
  cost_micros: number | null;
  created_at: string;
}

/**
 * A thing the platform can meter.
 *
 * `kind` matters: a `limit` is about what exists right now and can go down when
 * something is deleted; a `meter` is consumption within a subscription period
 * and does not go down until the period rolls. Treating them alike produces
 * "you used 3 seats this month", which is not a sentence about anything.
 */
export interface EntitlementMetric {
  key: string;
  kind: 'limit' | 'meter';
  /** A display label — 'seat', 'number', 'draft'. */
  unit: string;
  description: string;
  created_at: string;
}

/**
 * A sellable plan.
 *
 * Carries no price: a price is a currency, a tax treatment and a billing cycle,
 * and the payment provider is still an open decision. The catalogue also ships
 * empty — allowances are a product decision, and entitlement resolution fails
 * closed until rows exist (migration 20260903000001).
 */
export interface Plan {
  id: string;
  /** Stable identifier code refers to; renaming `name` must not change meaning. */
  key: string;
  name: string;
  /** Whether signup may offer it. A retired plan stays, because orgs are on it. */
  is_available: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** What one plan grants for one metric. */
export interface PlanEntitlement {
  plan_id: string;
  metric: string;
  /**
   * `null` means unlimited — not `-1`, not `MAX_SAFE_INTEGER`. A sentinel
   * participates in arithmetic and produces plausible nonsense; `null` forces
   * every reader to handle the case.
   */
  allowance: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Which plan an organization is on.
 *
 * `past_due` still resolves entitlements. Cutting a customer off the hour an
 * invoice fails is a dunning policy, not a side effect of a status enum.
 */
export interface OrganizationSubscription {
  id: string;
  organization_id: string;
  plan_id: string;
  status: 'active' | 'past_due' | 'canceled';
  /** The metering window for `meter` metrics. Both null or both set. */
  current_period_start: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A per-organization exception to its plan's allowance.
 *
 * This exists so the alternative does not happen: without it, granting one
 * customer one extra number is an edit to the plan row, which changes every
 * organization on that plan and looks afterwards like it was always that way.
 */
export interface OrganizationEntitlementOverride {
  organization_id: string;
  metric: string;
  /** `null` means unlimited, as on {@link PlanEntitlement}. */
  allowance: number | null;
  /** Required, minimum 8 characters — an unexplained override is a mistake. */
  reason: string;
  /** `null` is permanent. An expiry is what separates a trial from a price. */
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One row of `public.organization_entitlements(organization_id)`. */
export interface ResolvedEntitlement {
  metric: string;
  kind: 'limit' | 'meter';
  unit: string;
  /** `false` means no entitlement at all. Distinct from an allowance of 0. */
  granted: boolean;
  /** `null` with `granted: true` means unlimited. */
  allowance: number | null;
  used: number;
  source: 'override' | 'plan' | 'none';
}

/**
 * One native-currency cost total from `public.org_usage_summary`.
 *
 * A list rather than a single number because an organization can be billed by
 * one provider in USD and another in EUR (20260903000005), and summing across
 * currencies without converting them produces a number that means nothing.
 */
export interface UsageCostTotal {
  currency: string;
  /** Micro-units: 25000 is 0.025 of `currency`. */
  cost_micros: number;
}

/** One (provider, model, modality) group of `public.org_usage_summary`. */
export interface UsageProviderGroup {
  provider: string;
  /** As REPORTED by the adapter; `null` when the provider did not name one. */
  model: string | null;
  modality: 'text' | 'audio';
  events: number;
  /**
   * Events with no price in the book. Their cost is unknown and contributes
   * to no total — it is NOT valued at zero anywhere in this shape.
   */
  unpriced_events: number;
  /**
   * Priced events whose currency had no fx rate at their instant: present in
   * `costs` (native), absent from `accounting_cost_micros`.
   */
  unconverted_events: number;
  /** Sum of converted costs only; see `unconverted_events` for the gap. */
  accounting_cost_micros: number;
  /** Sums per dimension (`input_tokens`, `output_tokens`, `audio_seconds`). */
  quantities: Record<string, number>;
  costs: UsageCostTotal[];
}

/** The JSONB returned by `public.org_usage_summary(uuid, timestamptz, timestamptz)`. */
export interface UsageSummary {
  organization_id: string;
  /** `from` inclusive, `to` exclusive. */
  window: { from: string; to: string };
  accounting_currency: string;
  totals: {
    events: number;
    priced_events: number;
    unpriced_events: number;
    unconverted_events: number;
    accounting_cost_micros: number;
    quantities: Record<string, number>;
    costs_by_currency: UsageCostTotal[];
  };
  by_provider: UsageProviderGroup[];
}

/**
 * A person an organization talks to.
 *
 * Identity is `(organization_id, phone)` and deliberately NOT scoped to a
 * WhatsApp number: a business with a sales line and a support line that both
 * hear from the same human holds ONE contact, not two. Conversations remain
 * per-number; the person does not.
 *
 * Read-only from the application. Rows are created by the ingest path under
 * the definer, and `authenticated` holds `SELECT` and nothing else.
 */
export interface Contact {
  id: string;
  organization_id: string;
  /**
   * The WhatsApp identifier as the provider gives it, not normalised to E.164
   * — inbound messages arrive with this value and conversations are matched on
   * it.
   *
   * Immutable: the database rejects an update with SQLSTATE `P3E01`. A
   * different number is a different person, which is an insert and a merge,
   * not an edit.
   */
  phone: string;
  /**
   * Null until somebody supplies one. Left null rather than defaulted, so a
   * missing name stays distinguishable from a name that happens to read like a
   * placeholder.
   */
  display_name: string | null;
  created_at: string;
  /** When the row was last *edited* — not when the contact last messaged. */
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  organization_id: string;
  webhook_event_id: string;
  direction: 'inbound' | 'outbound';
  provider_message_id: string | null;
  body: string | null;
  status: 'received' | 'sent' | 'delivered' | 'read' | 'failed';
  created_at: string;
}

export interface FailedJob {
  id: string;
  webhook_event_id: string | null;
  job_type: string;
  request_id: string | null;
  error_code: string;
  attempts: number;
  queue_name: string;
  pgmq_msg_id: number;
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Omit<Profile, 'created_at' | 'updated_at'> & { created_at?: string; updated_at?: string };
        Update: Partial<Profile>;
      };
      organizations: {
        Row: Organization;
        // `locale` is optional on insert because the column carries a default
        // ('es'). Requiring it here would force every caller to name a language
        // it does not care about, and the one value they would all pass is the
        // one the database already supplies.
        Insert: Omit<Organization, 'id' | 'created_at' | 'updated_at' | 'locale'> & { id?: string; created_at?: string; updated_at?: string; locale?: OrganizationLocale };
        Update: Partial<Organization>;
      };
      organization_members: {
        Row: OrganizationMember;
        Insert: Omit<OrganizationMember, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<OrganizationMember>;
      };
      organization_invitations: {
        Row: OrganizationInvitation;
        // Read-only from the application as of 20260902000001: `authenticated`
        // holds SELECT and nothing else, and every write goes through
        // create_invitation / revoke_invitation / accept_invitation.
        Insert: never;
        Update: never;
      };
      audit_logs: {
        Row: AuditLog;
        Insert: Omit<AuditLog, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<AuditLog>;
      };
      feature_flags: {
        Row: FeatureFlag;
        Insert: Omit<FeatureFlag, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<FeatureFlag>;
      };
      business_profiles: {
        Row: BusinessProfile;
        Insert: Omit<BusinessProfile, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<BusinessProfile>;
      };
      whatsapp_connections: {
        Row: WhatsAppConnection;
        Insert: Omit<WhatsAppConnection, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<WhatsAppConnection>;
      };
      webhook_events: {
        Row: WebhookEvent;
        Insert: Omit<WebhookEvent, 'id' | 'received_at'> & { id?: string; received_at?: string };
        Update: Partial<WebhookEvent>;
      };
      inbound_message_staging: {
        Row: InboundMessageStaging;
        Insert: Omit<InboundMessageStaging, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<InboundMessageStaging>;
      };
      conversations: {
        Row: Conversation;
        // `activity_at` and `contact_id` are maintained by the database — the
        // first is a generated column that rejects writes, the second is set
        // by a trigger from (organization_id, contact_phone). `assigned_to`
        // defaults to NULL and is written via `assign_conversation`.
        Insert: Omit<Conversation, 'id' | 'created_at' | 'updated_at' | 'activity_at' | 'contact_id' | 'assigned_to'>
          & { id?: string; created_at?: string; updated_at?: string; activity_at?: never; contact_id?: string; assigned_to?: string | null };
        Update: Partial<Omit<Conversation, 'activity_at'>>;
      };
      conversation_events: {
        Row: ConversationEvent;
        // Read-only from the application. The RPCs insert; nothing else may
        // (migration 20260901000002 grants INSERT to service_role alone), for
        // the same reason `audit_logs` has exactly two writers — ADR-009.
        Insert: never;
        Update: never;
      };
      platform_secrets: {
        Row: PlatformSecret;
        Insert: Omit<PlatformSecret, 'id' | 'created_at' | 'updated_at'>
          & { id?: string; algorithm?: 'aes-256-gcm'; created_at?: string; updated_at?: string };
        Update: Partial<PlatformSecret>;
      };
      organization_secrets: {
        Row: OrganizationSecret;
        Insert: Omit<OrganizationSecret, 'id' | 'created_at' | 'updated_at'>
          & { id?: string; algorithm?: 'aes-256-gcm'; scopes?: string[]; created_at?: string; updated_at?: string };
        Update: Partial<OrganizationSecret>;
      };
      provider_prices: {
        Row: ProviderPrice;
        Insert: Omit<ProviderPrice, 'id' | 'created_at' | 'updated_at'>
          & { id?: string; currency?: 'USD'; effective_from?: string; created_at?: string; updated_at?: string };
        Update: Partial<ProviderPrice>;
      };
      provider_usage_events: {
        Row: ProviderUsageEvent;
        Insert: Omit<ProviderUsageEvent, 'id' | 'created_at'>
          & { id?: string; occurred_at?: string; currency?: 'USD'; metadata?: Record<string, unknown>; created_at?: string };
        Update: Partial<ProviderUsageEvent>;
      };
      provider_usage_components: {
        Row: ProviderUsageComponent;
        Insert: Omit<ProviderUsageComponent, 'id' | 'created_at'>
          & { id?: string; created_at?: string };
        Update: Partial<ProviderUsageComponent>;
      };
      entitlement_metrics: {
        Row: EntitlementMetric;
        Insert: Omit<EntitlementMetric, 'created_at'> & { created_at?: string };
        Update: Partial<EntitlementMetric>;
      };
      plans: {
        Row: Plan;
        Insert: Omit<Plan, 'id' | 'created_at' | 'updated_at'>
          & { id?: string; is_available?: boolean; sort_order?: number; created_at?: string; updated_at?: string };
        Update: Partial<Plan>;
      };
      plan_entitlements: {
        Row: PlanEntitlement;
        Insert: Omit<PlanEntitlement, 'created_at' | 'updated_at'>
          & { created_at?: string; updated_at?: string };
        Update: Partial<PlanEntitlement>;
      };
      organization_subscriptions: {
        Row: OrganizationSubscription;
        Insert: Omit<OrganizationSubscription, 'id' | 'created_at' | 'updated_at'>
          & { id?: string; status?: OrganizationSubscription['status']; created_at?: string; updated_at?: string };
        Update: Partial<OrganizationSubscription>;
      };
      organization_entitlement_overrides: {
        Row: OrganizationEntitlementOverride;
        Insert: Omit<OrganizationEntitlementOverride, 'created_at' | 'updated_at'>
          & { created_at?: string; updated_at?: string };
        Update: Partial<OrganizationEntitlementOverride>;
      };
      contacts: {
        Row: Contact;
        // No Insert/Update surface that differs from the row: the application
        // holds SELECT only. The shapes are here so a service-role caller is
        // typed, not because anything in the app writes this table.
        Insert: Omit<Contact, 'id' | 'created_at' | 'updated_at'>
          & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<Omit<Contact, 'phone'>>;
      };
      messages: {
        Row: Message;
        Insert: Omit<Message, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Message>;
      };
      failed_jobs: {
        Row: FailedJob;
        Insert: Omit<FailedJob, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<FailedJob>;
      };
      ai_draft_configs: {
        Row: AiDraftConfig;
        Insert: Omit<AiDraftConfig, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<AiDraftConfig>;
      };
      ai_drafts: {
        Row: AiDraft;
        Insert: Omit<AiDraft, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<AiDraft>;
      };
      ai_draft_revisions: {
        Row: AiDraftRevision;
        Insert: Omit<AiDraftRevision, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<AiDraftRevision>;
      };
      ai_draft_review_events: {
        Row: AiDraftReviewEvent;
        Insert: Omit<AiDraftReviewEvent, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<AiDraftReviewEvent>;
      };
      draft_generation_jobs: {
        Row: DraftGenerationJob;
        Insert: Omit<DraftGenerationJob, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<DraftGenerationJob>;
      };
      draft_quota_limits: {
        Row: DraftQuotaLimit;
        Insert: Omit<DraftQuotaLimit, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<DraftQuotaLimit>;
      };
      draft_usage_tracking: {
        Row: DraftUsageTracking;
        Insert: Omit<DraftUsageTracking, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<DraftUsageTracking>;
      };
      draft_usage_reservations: {
        Row: DraftUsageReservation;
        Insert: Omit<DraftUsageReservation, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<DraftUsageReservation>;
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      organization_connected_accounts: {
        Args: { p_organization_id: string };
        Returns: ConnectedAccount[];
      };
      record_provider_usage: {
        Args: {
          p_organization_id: string;
          p_modality: 'text' | 'audio';
          p_provider: string;
          p_model: string | null;
          /** e.g. `{ input_tokens: 1200, output_tokens: 340 }` or `{ audio_seconds: 137 }`. */
          p_quantities: Record<string, number>;
          p_provider_reference?: string | null;
          p_request_id?: string | null;
          p_draft_generation_job_id?: string | null;
          p_message_id?: string | null;
          p_metadata?: Record<string, unknown>;
          p_occurred_at?: string;
        };
        /** The new event's id. */
        Returns: string;
      };
      organization_entitlements: {
        Args: {
          p_organization_id: string;
        };
        Returns: ResolvedEntitlement[];
      };
      org_usage_summary: {
        Args: {
          p_organization_id: string;
          /** Inclusive. ISO timestamp on the wire. */
          p_from: string;
          /** Exclusive. ISO timestamp on the wire. */
          p_to: string;
        };
        Returns: UsageSummary;
      };
      create_organization_with_owner: {
        Args: {
          p_name: string;
          p_slug: string;
          p_owner_id: string;
        };
        Returns: string;
      };
      ingest_whatsapp_message_event: {
        Args: {
          p_provider_connection_identifier: string;
          p_provider: string;
          p_provider_event_key: string;
          p_event_kind: string;
          p_payload_sha256: string;
          p_provider_message_id: string;
          p_contact_identifier: string;
          p_message_kind: string;
          p_body_text: string;
          p_provider_timestamp: string;
          p_request_id: string;
        };
        Returns: { is_new: boolean; webhook_event_id: string };
      };
      process_inbound_message: {
        Args: {
          p_webhook_event_id: string;
        };
        Returns: {
          success: boolean;
          conversation_id: string | null;
          message_id: string | null;
          already_processed: boolean;
        };
      };
      archive_failed_job: {
        Args: {
          p_msg_id: string;
          p_request_id: string;
          p_error_code: string;
          p_attempts: number;
          p_webhook_event_id: string | null;
        };
        Returns: { archived: boolean; already_archived: boolean };
      };
      record_inbound_processing_failure: {
        Args: {
          p_webhook_event_id: string;
          p_error_code: string;
          p_attempt_count: number;
        };
        Returns: boolean;
      };
      read_whatsapp_inbound_jobs: {
        Args: {
          p_visibility_timeout_seconds: number;
          p_limit: number;
        };
        Returns: Array<{
          msg_id: string;
          read_ct: number;
          payload: Record<string, unknown>;
          enqueued_at: string;
          vt: string;
        }>;
      };
      delete_whatsapp_inbound_job: {
        Args: {
          p_msg_id: string;
        };
        Returns: boolean;
      };
      set_whatsapp_inbound_visibility: {
        Args: {
          p_msg_id: string;
          p_visibility_timeout_seconds: number;
        };
        Returns: boolean;
      };
      approve_draft: {
        Args: {
          p_draft_id: string;
          p_expected_lock_version: number;
        };
        Returns: {
          id: string;
          status: string;
          version: number;
          reviewed_at: string | null;
          reviewed_by: string | null;
        };
      };
      edit_draft: {
        Args: {
          p_draft_id: string;
          p_expected_lock_version: number;
          p_body: string;
        };
        Returns: {
          id: string;
          status: string;
          version: number;
          current_revision_id: string | null;
        };
      };
      reject_draft: {
        Args: {
          p_draft_id: string;
          p_expected_lock_version: number;
        };
        Returns: {
          id: string;
          status: string;
          version: number;
          rejected_at: string | null;
          rejected_by: string | null;
        };
      };
      /**
       * Returns the plaintext token exactly once. It is not stored and cannot
       * be recovered; a lost token means revoke and reissue.
       */
      create_invitation: {
        Args: {
          p_organization_id: string;
          p_email: string;
          p_role: OrganizationRole;
        };
        Returns: {
          invitation_id: string;
          token: string;
          email: string;
          role: OrganizationRole;
          expires_at: string;
        };
      };
      revoke_invitation: {
        Args: { p_invitation_id: string };
        Returns: { invitation_id: string; status: 'revoked' };
      };
      /**
       * Takes the PLAINTEXT token, not the stored hash. `role` is the role the
       * caller actually holds afterwards, which is not necessarily the invited
       * role: an existing membership is never rewritten.
       */
      accept_invitation: {
        Args: { p_token: string };
        Returns: {
          organization_id: string;
          membership_created: boolean;
          role: OrganizationRole;
        };
      };
      is_feature_enabled: {
        Args: {
          p_organization_id: string;
          p_flag_key: string;
        };
        Returns: boolean;
      };
      /**
       * `p_expected_assignee` is a compare-and-set, not a hint: the RPC raises
       * P3C04 if the row says something else. It is required rather than
       * optional so that "I saw it unassigned" cannot be the accidental
       * default — that is the value most likely to be wrong and the one that
       * silently wins a race between two reviewers.
       */
      assign_conversation: {
        Args: {
          p_conversation_id: string;
          p_assignee: string | null;
          p_expected_assignee: string | null;
        };
        Returns: {
          conversation_id: string;
          status: string;
          assigned_to: string | null;
        };
      };
      /**
       * Stops AI drafting for one conversation, or restarts it.
       * `process_inbound_message` enqueues a draft job only for `open`, so this
       * is a kill switch and not a label.
       */
      set_conversation_handoff: {
        Args: {
          p_conversation_id: string;
          p_needs_human: boolean;
          p_expected_status: string;
        };
        Returns: {
          conversation_id: string;
          status: string;
          assigned_to: string | null;
        };
      };
    };
    Enums: {
      organization_role: OrganizationRole;
      invitation_status: InvitationStatus;
    };
  };
}
