import type { AgentModel, AgentOpenMaExtensions } from "../agents";
import type {
  AgentMcpServer,
  AgentSkill,
  AgentTool,
} from "../agents";
import type { SessionResource } from "./resource";
import type { SessionThreadAgent } from "./thread";

export type SessionStatus = "rescheduling" | "running" | "idle" | "terminated";

export interface MonetaryAmount {
  amountMinor: string;
  currency: "USD";
}

export interface SessionAgent {
  id: string;
  description: string | null;
  mcpServers: AgentMcpServer[];
  model: AgentModel;
  multiagent: SessionAgentMultiagent | null;
  name: string;
  openma?: AgentOpenMaExtensions;
  skills: AgentSkill[];
  system: string | null;
  tools: AgentTool[];
  version: number;
}

export interface SessionAgentMultiagent {
  agents: SessionThreadAgent[];
  type: "coordinator";
}

export interface SessionStats {
  activeSeconds?: number;
  durationSeconds?: number;
}

export interface SessionUsage {
  activeSeconds?: number;
  cacheCreation?: {
    ephemeralOneHourInputTokens?: number;
    ephemeralFiveMinuteInputTokens?: number;
  };
  cacheReadInputTokens?: number;
  inputTokens?: number;
  listCost?: MonetaryAmount | null;
  outputTokens?: number;
  serverToolUse?: {
    webFetchRequests?: number;
    webSearchRequests?: number;
  } | null;
}

export interface SessionOutcomeEvaluation {
  type: "outcome_evaluation";
  completedAt: string | null;
  description: string;
  explanation: string | null;
  iteration: number;
  outcomeId: string;
  result: string;
}

/**
 * Who created the session — the attribution dimension the usage ledger
 * inherits. member = a signed-in human (Console/cookie/personal key);
 * api_key = a workspace key (machine identity); integration = a
 * third-party surface. id is null when the identity is not surfaced
 * (workspace keys today) — never fabricated.
 */
export interface SessionActor {
  type: "member" | "api_key" | "integration";
  id: string | null;
}

export interface Session {
  id: string;
  agent: SessionAgent;
  archivedAt: string | null;
  budget: MonetaryAmount | null;
  createdAt: string;
  environmentId: string;
  metadata: Record<string, string>;
  outcomeEvaluations: SessionOutcomeEvaluation[];
  resources: SessionResource[];
  stats: SessionStats;
  status: SessionStatus;
  title: string | null;
  updatedAt: string;
  usage: SessionUsage;
  vaultIds: string[];
  deploymentId?: string | null;
  actor?: SessionActor;
}
