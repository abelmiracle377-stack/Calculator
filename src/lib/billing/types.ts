export type PaymentMethod =
  | "NIGERIA_BANK_TRANSFER"
  | "UK_BANK_TRANSFER"
  | "USA_BANK_TRANSFER"
  | "CRYPTO";

export type BillingStatus = "NONE" | "PENDING" | "ACTIVE" | "EXPIRED";
export type AccessLifecycleStatus = "TRIALING" | "TRIAL_EXPIRED" | "PAYMENT_PENDING" | "PREMIUM_ACTIVE" | "PREMIUM_EXPIRED" | "ADMIN_RESTRICTED";
export type PaymentSubmissionStatus = "PENDING" | "APPROVED" | "REJECTED";
export type PaymentCountry = "NG" | "UK" | "US" | "CRYPTO";
export type NotificationStatus = "NOT_ATTEMPTED" | "SENT" | "FAILED" | "SKIPPED";
export type AdminRole = "user" | "administrator";
export type AdminGrantStatus = "none" | "active" | "revoked" | "root";

export interface NotificationOutcome {
  status: NotificationStatus;
  message: string;
}

export interface BankDetails {
  bank_name?: string;
  account_name?: string;
  account_number?: string;
  account_holder_name?: string;
  routing_number?: string;
  sort_code?: string;
  iban?: string;
  bic_swift?: string;
  bank_address?: string;
  account_holder_address?: string;
  instructions?: string;
}

export interface CryptoOption {
  id: string;
  name: string;
  network: string;
  wallet_address: string;
  instructions: string;
  enabled?: boolean;
  display_order?: number;
}

export interface PaymentMethodOption {
  id: PaymentMethod;
  label: string;
  country: PaymentCountry;
  expected_amount: number;
  expected_currency: string;
  exchange_rate: number;
  exchange_rate_mode: "MANUAL" | "NONE";
  exchange_rate_timestamp: string;
  bank?: BankDetails;
  crypto_options?: CryptoOption[];
}

export interface UnavailablePaymentMethod {
  id: PaymentMethod;
  label: string;
  reason: string;
}

export interface PaymentOptionsResponse {
  base_amount_usd: number;
  methods: PaymentMethodOption[];
  unavailable_methods: UnavailablePaymentMethod[];
}

export interface UserSubscriptionSummary {
  status: BillingStatus;
  premium_start: string;
  premium_end: string;
  latest_payment_id: string;
  payment_method: string;
  amount: number;
  currency: string;
}

export interface UserSubmissionSummary {
  id: string;
  payment_method: PaymentMethod;
  country: PaymentCountry;
  claimed_amount: number;
  claimed_currency: string;
  expected_amount: number;
  expected_currency: string;
  exchange_rate: number;
  exchange_rate_mode: string;
  exchange_rate_timestamp: string;
  transaction_reference: string;
  payment_date: string;
  submitted_at: string;
  status: PaymentSubmissionStatus;
  premium_start: string;
  premium_end: string;
  crypto_name: string;
  crypto_network: string;
  notification_status: NotificationStatus;
  notification_attempted_at: string;
  notification_message: string;
}

export interface UserBillingStatusResponse {
  subscription: UserSubscriptionSummary;
  submissions: UserSubmissionSummary[];
}

export interface UserAccessStatusResponse {
  ok: true;
  status: AccessLifecycleStatus;
  can_transcribe: boolean;
  trial_start: string;
  trial_end: string;
  premium_start: string;
  premium_end: string;
  has_pending_payment: boolean;
  pending_payment_submitted_at: string;
  checked_at: string;
}

export interface SubmitPaymentResponse extends UserBillingStatusResponse {
  ok: true;
  status: "PENDING";
  payment_id: string;
  notification: NotificationOutcome;
}

export interface AdminSettings {
  id: string;
  settings_key: string;
  premium_price_usd: number;
  nigeria_enabled: boolean;
  nigeria_bank_name: string;
  nigeria_account_name: string;
  nigeria_account_number: string;
  nigeria_instructions: string;
  nigeria_ngn_rate: number;
  nigeria_rate_timestamp: string;
  uk_enabled: boolean;
  uk_account_holder_name: string;
  uk_bank_name: string;
  uk_account_number: string;
  uk_sort_code: string;
  uk_iban: string;
  uk_bic_swift: string;
  uk_bank_address: string;
  uk_account_holder_address: string;
  uk_instructions: string;
  uk_gbp_rate: number;
  uk_rate_timestamp: string;
  usa_enabled: boolean;
  usa_account_holder_name: string;
  usa_bank_name: string;
  usa_account_number: string;
  usa_routing_number: string;
  usa_bank_address: string;
  usa_account_holder_address: string;
  usa_instructions: string;
}

export interface AdminPaymentRow extends UserSubmissionSummary {
  owner_email: string;
  admin_reason: string;
  base_amount_usd: number;
  receipt_id: string;
  note: string;
  admin_decision: string;
  verification_at: string;
  premium_status: "" | "ACTIVE" | "EXPIRED";
  admin_notification_status: NotificationStatus;
  admin_notification_attempted_at: string;
  admin_notification_error: string;
  payer_notification_status: NotificationStatus;
  payer_notification_attempted_at: string;
  payer_notification_error: string;
}

export interface BillingCounts {
  total_users: number | null;
  pending: number;
  active: number;
  expired: number;
  approved: number;
  rejected: number;
}

export interface CurrencyTotal {
  currency: string;
  amount: number;
}

export interface ActivityTrendPoint {
  date: string;
  submissions: number;
  approvals: number;
  rejections: number;
  expirations: number;
}

export interface BillingAuditRow {
  id: string;
  action: string;
  actor_email: string;
  subject_email: string;
  related_payment_id: string;
  related_subscription_id: string;
  summary: string;
  metadata_text: string;
  created_at: string;
}

export interface AdminOverview {
  counts: BillingCounts;
  approved_volume_usd: number;
  approved_local_currency_totals: CurrencyTotal[];
  activity_trend: ActivityTrendPoint[];
  recent_payments: AdminPaymentRow[];
  recent_activity: BillingAuditRow[];
}

export interface AdminDecisionResponse {
  payment: AdminPaymentRow;
  notification?: NotificationOutcome;
}

export interface ProtectedReceiptPayload {
  payment_id: string;
  original_filename: string;
  mime_type: string;
  payload_data: string;
  byte_size: number;
}

export type AdminLifecycleStatus = AccessLifecycleStatus | "NOT_INITIALIZED";

export interface AdminDataScope {
  user_list_available: boolean;
  user_list_source: "platform_accounts" | "access_profiles_only";
  total_users: number | null;
  total_profiles: number;
  account_timing_note: string;
}

export interface AdminOverviewCounts {
  total_users: number | null;
  total_profiles: number;
  trialing: number;
  trial_expired: number;
  payment_pending: number;
  premium_active: number;
  premium_expired: number;
  manually_restricted: number;
  not_initialized: number;
}

export interface AdminOverviewResponse {
  counts: AdminOverviewCounts;
  scope: AdminDataScope;
}

export interface AdminLatestPayment {
  id: string;
  status: string;
  payment_method: string;
  country: string;
  claimed_amount: number;
  claimed_currency: string;
  submitted_at: string;
  verification_at: string;
  transaction_reference: string;
  premium_start: string;
  premium_end: string;
}

export interface AdminUserRow {
  id: string;
  user_id: string;
  profile_id: string;
  email: string;
  name: string;
  profile_available: boolean;
  lifecycle_status: AdminLifecycleStatus;
  effective_role: AdminRole;
  is_root_admin: boolean;
  is_granted_admin: boolean;
  is_current_admin: boolean;
  is_protected_admin: boolean;
  admin_grant_status: AdminGrantStatus;
  admin_granted_at: string;
  admin_granted_by: string;
  admin_revoked_at: string;
  admin_revoked_by: string;
  account_timestamp: string;
  account_timestamp_label: string;
  account_timestamp_source: "account_created_at" | "first_authenticated_at" | "unavailable";
  profile_updated_at: string;
  trial_start: string;
  trial_end: string;
  premium_start: string;
  premium_end: string;
  pending_payment_id: string;
  pending_payment_submitted_at: string;
  payment_status: string;
  latest_payment: AdminLatestPayment | null;
  manual_restricted: boolean;
  restriction_reason: string;
  manual_restricted_at: string;
  first_activity_at: string;
  last_activity_at: string;
  first_ip: string;
  first_ip_at: string;
  last_ip: string;
  last_ip_at: string;
  internal_note: string;
}

export interface AdminUsersResponse {
  users: AdminUserRow[];
  scope: AdminDataScope;
}

export interface AdminAccessHistoryRow {
  id: string;
  kind: "access" | "billing";
  action: string;
  target_user_email: string;
  actor_label: string;
  occurred_at: string;
  note: string;
  related_payment_id: string;
  related_subscription_id: string;
  summary: string;
  metadata_text: string;
}

export interface AdminUserDetailResponse {
  user: AdminUserRow;
  history: AdminAccessHistoryRow[];
}

export interface AdminAccessActionResponse {
  ok: true;
  action: string;
  user: AdminUserRow;
  audit?: { action: string; occurred_at: string };
}

export type AdminRoleAction = "grant_admin" | "revoke_admin";
export interface AdminRoleActionResponse extends AdminAccessActionResponse {
  action: "ADMIN_GRANTED" | "ADMIN_REVOKED" | "ADMIN_ALREADY_GRANTED" | "ADMIN_ALREADY_REVOKED";
}

export interface AdminHistoryResponse {
  access_events: AdminAccessHistoryRow[];
  billing_events: AdminAccessHistoryRow[];
}
