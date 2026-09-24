export const CYBER_USER_ASSET_TYPES = [
  "Domain",
  "Subdomain",
  "IPv4",
  "IPv6",
  "Website",
  "API endpoint",
  "Network service",
] as const;
export type CyberUserAssetType = (typeof CYBER_USER_ASSET_TYPES)[number];

export const CYBER_TESTING_METHODS = [
  "PORT_DISCOVERY",
  "SERVICE_IDENTIFICATION",
  "HTTP_SECURITY_REVIEW",
  "TLS_CONFIGURATION_REVIEW",
  "DNS_CONFIGURATION_REVIEW",
  "VULNERABILITY_ASSESSMENT",
] as const;
export type CyberTestingMethod = (typeof CYBER_TESTING_METHODS)[number];

export const CYBER_TESTING_METHOD_LABELS: Record<CyberTestingMethod, string> = {
  PORT_DISCOVERY: "Port discovery",
  SERVICE_IDENTIFICATION: "Service identification",
  HTTP_SECURITY_REVIEW: "HTTP security review",
  TLS_CONFIGURATION_REVIEW: "TLS configuration review",
  DNS_CONFIGURATION_REVIEW: "DNS configuration review",
  VULNERABILITY_ASSESSMENT: "Vulnerability assessment",
};

export const CYBER_WORKFLOW_STAGES = [
  "Reconnaissance",
  "Discovery",
  "Port scanning",
  "Service enumeration",
  "Technology identification",
  "Vulnerability discovery",
  "Vulnerability analysis",
  "Controlled validation",
  "Evidence collection",
  "Risk assessment",
  "Remediation",
  "Retesting",
  "Report",
] as const;
export type CyberWorkflowStage = (typeof CYBER_WORKFLOW_STAGES)[number];

export const CYBER_TOOL_INTENTS = [
  "Nmap",
  "Nuclei",
  "OWASP ZAP",
  "Metasploit",
  "DNS enumeration",
  "HTTP/HTTPS analysis",
  "TLS analysis",
  "No tool proposed",
] as const;
export type CyberToolIntent = (typeof CYBER_TOOL_INTENTS)[number];

export const CYBER_RESULT_STATUS = "NOT_RUN" as const;
export type CyberResultStatus = typeof CYBER_RESULT_STATUS;
export type CyberAssetStatus = "ACTIVE" | "ARCHIVED";
export type CyberAuthorizationStatus = "PENDING" | "ACTIVE" | "REVOKED" | "EXPIRED";
export type CyberSessionStatus = "PLANNING" | "ARCHIVED";
export type CyberStepKind = "USER_MESSAGE" | "AI_PLAN";
export type CyberAuditOutcome = "SUCCESS" | "DENIED" | "VALIDATION_FAILED" | "ERROR";

export interface CyberUserAsset {
  id: string;
  name: string;
  asset_type: CyberUserAssetType;
  target: string;
  description: string;
  status: CyberAssetStatus;
  owner_email: string;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
  archived_at: string;
  archived_by: string;
  last_updated_by: string;
}

export interface CyberUserAuthorization {
  id: string;
  asset_id: string;
  asset_target: string;
  asset_type: CyberUserAssetType;
  scope_target: string;
  scope_ports: string[];
  scope_web_paths: string[];
  allowed_testing_methods: CyberTestingMethod[];
  evidence_reference: string;
  valid_from: string;
  valid_until: string;
  status: CyberAuthorizationStatus;
  owner_email: string;
  owner_user_id: string;
  requested_by: string;
  requested_by_user_id: string;
  approved_by: string;
  approved_at: string;
  approval_note: string;
  revoked_by: string;
  revoked_at: string;
  revocation_note: string;
}

export interface CyberUserAssessmentSession {
  id: string;
  asset_id: string;
  authorization_id: string;
  title: string;
  status: CyberSessionStatus;
  current_stage: CyberWorkflowStage;
  owner_email: string;
  owner_user_id: string;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  step_count: number;
}

export interface CyberUserAssessmentStep {
  id: string;
  session_id: string;
  step_number: number;
  step_kind: CyberStepKind;
  user_message: string;
  workflow_stage: CyberWorkflowStage;
  proposed_tool: CyberToolIntent;
  action: string;
  configuration_summary: string;
  result_status: CyberResultStatus;
  result_message: string;
  explanation: string;
  next_step: string;
  owner_email: string;
  owner_user_id: string;
  created_at: string;
}

export interface CyberUserAuditEvent {
  id: string;
  action: string;
  outcome: CyberAuditOutcome;
  message: string;
  asset_id: string;
  authorization_id: string;
  session_id: string;
  target_snapshot: string;
  owner_email: string;
  owner_user_id: string;
  occurred_at: string;
}

export interface CyberUserMetrics {
  total_assets: number;
  active_assets: number;
  active_authorizations: number;
  planning_sessions: number;
  pending_tool_intents: number;
}

export interface CyberUserOverview {
  assets: CyberUserAsset[];
  authorizations: CyberUserAuthorization[];
  sessions: CyberUserAssessmentSession[];
  audit_events: CyberUserAuditEvent[];
  metrics: CyberUserMetrics;
  scope: {
    planning_enabled: boolean;
    live_runner_connected: boolean;
    external_targets_contacted: boolean;
    boundary_message: string;
  };
}

export interface CyberPlanResponse {
  workflow_stage: CyberWorkflowStage;
  proposed_tool: CyberToolIntent;
  action: string;
  configuration_summary: string;
  result_status: CyberResultStatus;
  result_message: string;
  explanation: string;
  next_step: string;
}

export interface CyberSessionDetail {
  session: CyberUserAssessmentSession;
  steps: CyberUserAssessmentStep[];
}
