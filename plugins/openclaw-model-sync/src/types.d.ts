export type Reasoning = { supported: boolean | null; source: string; detail: string };
export type Api = 'openai-completions' | 'openai-responses' | 'anthropic-messages';
export type Secret = string | { source: string; provider?: string; id: string };
export type Model = {
  id: string; name?: string; reasoning?: boolean; input?: string[];
  contextWindow?: number; maxTokens?: number; cost?: Record<string, number>;
  [key: string]: unknown;
};
export type DiscoveredModel = {
  id: string; name?: string; reasoning: Reasoning; input?: string[];
  contextWindow?: number; maxTokens?: number;
};
export type Provider = {
  baseUrl: string; api?: string; apiKey?: Secret; headers?: Record<string, Secret>;
  authHeader?: boolean; models?: Model[]; [key: string]: unknown;
};
export type Config = {
  models?: { providers?: Record<string, Provider>; [key: string]: unknown };
  agents?: {
    defaults?: { modelPolicy?: { allow?: string[] }; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
export type Settings = {
  providers: string[]; timeoutMs: number; prune: boolean;
  defaultContextWindow: number; defaultMaxTokens: number;
  reasoningOverrides: Record<string, boolean>; enableAgentTool: boolean;
};
export type FollowUp = { mode: string; requiresRestart: boolean; reason?: string };
export type ConfigRuntime = {
  current(): Config;
  mutateConfigFile<T>(options: {
    afterWrite: { mode: 'auto' };
    mutate(draft: Config): T;
  }): Promise<{ result?: T; followUp: FollowUp }>;
};
export type ProviderReport = {
  provider: string; added: string[]; updated: string[]; removed: string[];
  retained: string[]; unchanged: string[]; reasoning: Record<string, Reasoning>;
  warnings: string[]; policyAdded: boolean;
};
export type SyncReport = {
  dryRun: boolean; prune: boolean; changed: boolean; providers: ProviderReport[];
  errors: { provider: string; message: string }[]; followUp?: FollowUp;
};
