export const CYBER_ASSET_TYPES = [
  "Domain",
  "Subdomain",
  "IPv4",
  "IPv6",
  "Website",
  "API endpoint",
  "Network service",
] as const;

export type CyberAssetType = (typeof CYBER_ASSET_TYPES)[number];
export const CYBER_ASSET_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type CyberAssetStatus = (typeof CYBER_ASSET_STATUSES)[number];

export const CYBER_TESTING_METHODS = [
  "PORT_DISCOVERY",
  "SERVICE_IDENTIFICATION",
  "HTTP_SECURITY_REVIEW",
  "TLS_CONFIGURATION_REVIEW",
  "DNS_CONFIGURATION_REVIEW",
  "VULNERABILITY_ASSESSMENT",
] as const;
export type CyberTestingMethod = (typeof CYBER_TESTING_METHODS)[number];

export const CYBER_AUTH_STATUSES = ["PENDING", "ACTIVE", "REVOKED", "EXPIRED"] as const;
export type CyberAuthorizationStatus = (typeof CYBER_AUTH_STATUSES)[number];

export interface CyberAsset {
  id: string;
  name: string;
  asset_type: CyberAssetType;
  target: string;
  description: string;
  status: CyberAssetStatus;
  owner_email: string;
  created_at: string;
  updated_at: string;
  archived_at: string;
  archived_by: string;
  last_updated_by: string;
}

export interface CyberAuthorizationRecord {
  id: string;
  asset_id: string;
  asset_target: string;
  asset_type: CyberAssetType;
  scope_target: string;
  scope_ports: string[];
  scope_web_paths: string[];
  allowed_testing_methods: CyberTestingMethod[];
  evidence_reference: string;
  valid_from: string;
  valid_until: string;
  status: CyberAuthorizationStatus;
  owner_email: string;
  requested_by: string;
  approved_by: string;
  approved_at: string;
  approval_note: string;
  renewed_by: string;
  renewed_at: string;
  renewal_note: string;
  revoked_by: string;
  revoked_at: string;
  revocation_note: string;
}

export interface CyberAuditEvent {
  id: string;
  action: string;
  outcome: "SUCCESS" | "DENIED" | "VALIDATION_FAILED" | "ERROR";
  actor_email: string;
  actor_user_id: string;
  asset_id: string;
  authorization_id: string;
  target_snapshot: string;
  message: string;
  occurred_at: string;
}

export interface CyberSecurityMetrics {
  total_assets: number;
  active_assets: number;
  active_authorizations: number;
  authorizations_expiring_30_days: number;
}

export interface CyberSecurityOverview {
  assets: CyberAsset[];
  authorization_records: CyberAuthorizationRecord[];
  audit_events: CyberAuditEvent[];
  metrics: CyberSecurityMetrics;
  scope: {
    assessment_enabled: false;
    external_targets_contacted: false;
    future_role_expansion: string;
  };
}

export type CyberSecurityAction =
  | "overview"
  | "list"
  | "audit_events"
  | "create_asset"
  | "update_asset"
  | "archive_asset"
  | "create_authorization"
  | "approve_authorization"
  | "renew_authorization"
  | "revoke_authorization";
