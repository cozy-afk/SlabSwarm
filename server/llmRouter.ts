import { randomUUID } from 'node:crypto';
import { GoogleGenAI, Type } from '@google/genai';
import type {
  LLMProviderId,
  LLMProviderInfo,
  SwarmAgentRole,
  SwarmRoutingConfig,
} from '../src/types/graph.ts';
import { validateHermesOutboundUrl } from './hermesBridge.ts';
import {
  applyStoredSettingsToEnv,
  hasStoredCredentials,
  loadStoredRouting,
  saveStoredRouting,
  PROVIDER_ENV_FIELDS,
} from './llmSettings.ts';

applyStoredSettingsToEnv();

export interface StructuredSchemaField {
  type: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'ARRAY';
  description?: string;
  itemsType?: 'STRING' | 'NUMBER';
}

export interface LLMCallOptions {
  role: SwarmAgentRole;
  systemInstruction: string;
  prompt: string;
  providerOverride?: LLMProviderId;
  jsonSchema?: Record<string, StructuredSchemaField>;
}

export interface LLMCallResult<T = string> {
  data: T;
  providerId: LLMProviderId;
  providerLabel: string;
  model: string;
  latencyMs: number;
}

const VALID_PROVIDER_IDS: LLMProviderId[] = [
  'gemini',
  'hermes',
  'openai',
  'anthropic',
  'ollama',
];

let routingInitialized = false;
// OpenCode Go requires a stable session header on every request. This app is
// single-operator, so one process-scoped session ID is sufficient.
const OPENCODE_SESSION_ID = `slabswarm-${randomUUID()}`;
const routingConfig: SwarmRoutingConfig = {
  entityResolution: 'gemini',
  outlierFilter: 'gemini',
  catalystSentiment: 'gemini',
  graphRagSynthesis: 'gemini',
};

function ensureRoutingInitialized(): void {
  if (routingInitialized) return;
  routingInitialized = true;

  const stored = loadStoredRouting();
  if (stored) {
    (Object.keys(routingConfig) as SwarmAgentRole[]).forEach((role) => {
      const value = stored[role];
      if (VALID_PROVIDER_IDS.includes(value)) routingConfig[role] = value;
    });
    return;
  }

  const providers = getAvailableProviders();
  const configuredIds = new Set(
    providers.filter((p) => p.configured).map((p) => p.id)
  );
  if (configuredIds.size === 0) return;

  const envDefault = (process.env.LLM_DEFAULT_PROVIDER || '')
    .trim()
    .toLowerCase() as LLMProviderId;

  const chosen: LLMProviderId =
    VALID_PROVIDER_IDS.includes(envDefault) && configuredIds.has(envDefault)
      ? envDefault
      : configuredIds.has('gemini')
        ? 'gemini'
        : providers.find((p) => p.configured)!.id;

  routingConfig.entityResolution = chosen;
  routingConfig.outlierFilter = chosen;
  routingConfig.catalystSentiment = chosen;
  routingConfig.graphRagSynthesis = chosen;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured on the server. Add it to your server .env file.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function getAvailableProviders(): LLMProviderInfo[] {
  const geminiKey = process.env.GEMINI_API_KEY;
  const hermesUrl = process.env.HERMES_API_URL;
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const ollamaUrl = process.env.OLLAMA_BASE_URL;

  const providers: Array<Omit<LLMProviderInfo, 'credentialFields' | 'hasStoredCredentials'>> = [
    {
      id: 'gemini',
      label: 'Google Gemini',
      defaultModel: process.env.GEMINI_MODEL || 'gemini-4-hydrogen',
      configured: Boolean(geminiKey && geminiKey !== 'MY_GEMINI_API_KEY'),
      envHint: 'GEMINI_API_KEY',
      description: 'Active server-side Gemini SDK with native structured JSON schema enforcement.',
    },
    {
      id: 'hermes',
      label: 'Hermes Agent Gateway',
      defaultModel: process.env.HERMES_MODEL || 'hermes-agent',
      configured: Boolean(hermesUrl && hermesUrl.trim().length > 0),
      envHint: 'HERMES_API_URL + HERMES_API_KEY',
      description: 'Connects directly to your Nous Research Hermes Agent API server (:8642/v1).',
    },
    {
      id: 'openai',
      label: 'OpenAI-Compatible',
      defaultModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      configured: Boolean(openaiKey && openaiKey.trim().length > 0),
      envHint: 'OPENAI_API_KEY + OPENAI_BASE_URL',
      description: 'Supports OpenAI, OpenRouter, Groq, Together, or self-hosted vLLM gateways.',
    },
    {
      id: 'anthropic',
      label: 'Anthropic Claude',
      defaultModel: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
      configured: Boolean(anthropicKey && anthropicKey.trim().length > 0),
      envHint: 'ANTHROPIC_API_KEY',
      description: 'Server-side Anthropic Messages API for high-precision reasoning & synthesis.',
    },
    {
      id: 'ollama',
      label: 'Local Ollama',
      defaultModel: process.env.OLLAMA_MODEL || 'llama3.1:8b',
      configured: Boolean(ollamaUrl && ollamaUrl.trim().length > 0),
      envHint: 'OLLAMA_BASE_URL',
      description: 'Private on-premise inference for zero-cost local Swarm scraping pipelines.',
    },
  ];
  return providers.map((provider): LLMProviderInfo => ({
    ...provider,
    credentialFields: PROVIDER_ENV_FIELDS[provider.id],
    hasStoredCredentials: hasStoredCredentials(provider.id),
  }));
}

export function getSwarmRouting(): SwarmRoutingConfig {
  ensureRoutingInitialized();
  return { ...routingConfig };
}

export function updateSwarmRouting(
  patch: Partial<SwarmRoutingConfig>
): SwarmRoutingConfig {
  ensureRoutingInitialized();
  const providers = getAvailableProviders();
  const configuredIds = new Set(
    providers.filter((p) => p.configured).map((p) => p.id)
  );

  (Object.keys(patch) as SwarmAgentRole[]).forEach((role) => {
    const requested = patch[role];
    if (!requested) return;
    if (!configuredIds.has(requested)) {
      throw new Error(
        `Provider "${requested}" is not configured on the server. Set its environment variable in your server runtime to enable it.`
      );
    }
    routingConfig[role] = requested;
  });

  saveStoredRouting(routingConfig);
  return { ...routingConfig };
}

function buildGeminiSchema(schema: Record<string, StructuredSchemaField>) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(schema)) {
    required.push(key);
    if (field.type === 'ARRAY') {
      properties[key] = {
        type: Type.ARRAY,
        description: field.description,
        items: {
          type: field.itemsType === 'NUMBER' ? Type.NUMBER : Type.STRING,
        },
      };
    } else if (field.type === 'NUMBER') {
      properties[key] = { type: Type.NUMBER, description: field.description };
    } else if (field.type === 'BOOLEAN') {
      properties[key] = { type: Type.BOOLEAN, description: field.description };
    } else {
      properties[key] = { type: Type.STRING, description: field.description };
    }
  }

  return {
    type: Type.OBJECT,
    properties,
    required,
  };
}

function extractJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(candidate);
}

function formatProviderError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw) as {
      error?: { code?: number; message?: string; status?: string };
    };
    if (parsed?.error?.message) {
      const code = parsed.error.code ? ` (${parsed.error.code})` : '';
      return `${parsed.error.message}${code}`;
    }
  } catch {
    // Not a JSON-encoded error string
  }
  return raw;
}

async function callGemini(
  options: LLMCallOptions,
  model: string
): Promise<{ text: string; modelUsed: string }> {
  const ai = getGeminiClient();
  const config: Record<string, unknown> = {
    systemInstruction: options.systemInstruction,
  };

  if (options.jsonSchema) {
    config.responseMimeType = 'application/json';
    config.responseSchema = buildGeminiSchema(options.jsonSchema);
  }

  const candidateModels =
    model === 'gemini-4-hydrogen'
      ? [model, 'gemini-3.1-flash-lite']
      : [model];

  let lastErr: unknown;
  for (let i = 0; i < candidateModels.length; i += 1) {
    const activeModel = candidateModels[i];
    try {
      const response = await ai.models.generateContent({
        model: activeModel,
        contents: options.prompt,
        config,
      });

      const text = response.text;
      if (!text) {
        throw new Error('Gemini returned an empty response payload.');
      }
      return { text, modelUsed: activeModel };
    } catch (err) {
      lastErr = err;
      const msg = formatProviderError(err);
      const isTransient = /503|UNAVAILABLE|high demand|overloaded|429/i.test(msg);
      if (isTransient && i + 1 < candidateModels.length) {
        continue;
      }
      throw new Error(msg);
    }
  }

  throw new Error(formatProviderError(lastErr));
}

async function callOpenAICompatible(
  options: LLMCallOptions,
  model: string
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set on the server.');
  }
  const baseUrl = (
    process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  ).replace(/\/+$/, '');

  const schemaHint = options.jsonSchema
    ? `\nReturn strictly valid JSON with keys: ${Object.keys(options.jsonSchema).join(', ')}.`
    : '';

  const isOpenCodeGo =
    baseUrl.includes('opencode.ai') &&
    (baseUrl.includes('/go') || baseUrl.includes('/zen/go'));

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'SlabSwarm/1.0',
  };
  if (isOpenCodeGo) {
    headers['x-opencode-session'] = OPENCODE_SESSION_ID;
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: options.systemInstruction + schemaHint },
        { role: 'user', content: options.prompt },
      ],
      ...(options.jsonSchema
        ? { response_format: { type: 'json_object' } }
        : {}),
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenAI-compatible provider error (${res.status}): ${errBody}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenAI-compatible provider returned an empty response.');
  }
  return content;
}

async function callAnthropic(
  options: LLMCallOptions,
  model: string
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set on the server.');
  }

  const schemaHint = options.jsonSchema
    ? `\nRespond ONLY with a single raw JSON object containing keys: ${Object.keys(options.jsonSchema).join(', ')}.`
    : '';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: options.systemInstruction + schemaHint,
      messages: [{ role: 'user', content: options.prompt }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic provider error (${res.status}): ${errBody}`);
  }

  const json = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const content = json.content?.find((c) => c.type === 'text')?.text;
  if (!content) {
    throw new Error('Anthropic returned an empty response.');
  }
  return content;
}

async function callOllama(
  options: LLMCallOptions,
  model: string
): Promise<string> {
  const baseUrl = (process.env.OLLAMA_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('OLLAMA_BASE_URL is not set on the server.');
  }

  const schemaHint = options.jsonSchema
    ? `\nReturn strictly valid JSON with keys: ${Object.keys(options.jsonSchema).join(', ')}.`
    : '';

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      ...(options.jsonSchema ? { format: 'json' } : {}),
      messages: [
        { role: 'system', content: options.systemInstruction + schemaHint },
        { role: 'user', content: options.prompt },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Ollama provider error (${res.status}): ${errBody}`);
  }

  const json = (await res.json()) as { message?: { content?: string } };
  const content = json.message?.content;
  if (!content) {
    throw new Error('Ollama returned an empty response.');
  }
  return content;
}

async function callHermesGateway(
  options: LLMCallOptions,
  model: string
): Promise<string> {
  const rawUrl = process.env.HERMES_API_URL?.trim();
  if (!rawUrl) {
    throw new Error('HERMES_API_URL is not configured on the server.');
  }
  const baseUrl = validateHermesOutboundUrl(rawUrl)
    .toString()
    .replace(/\/+$/, '');
  const apiKey = process.env.HERMES_API_KEY?.trim();

  const schemaHint = options.jsonSchema
    ? `\nReturn strictly valid JSON with keys: ${Object.keys(options.jsonSchema).join(', ')}.`
    : '';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: options.systemInstruction + schemaHint },
        { role: 'user', content: options.prompt },
      ],
    }),
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Hermes Gateway error (${res.status}): ${errBody.slice(0, 240)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Hermes Gateway returned an empty response.');
  }
  return content;
}

export async function invokeSwarmLLM<T = string>(
  options: LLMCallOptions
): Promise<LLMCallResult<T>> {
  ensureRoutingInitialized();
  const providers = getAvailableProviders();
  const targetId = options.providerOverride || routingConfig[options.role];
  const provider = providers.find((p) => p.id === targetId);

  if (!provider || !provider.configured) {
    throw new Error(
      `Assigned server LLM provider "${targetId}" is not configured. Configure ${provider?.envHint || 'GEMINI_API_KEY'} on the server.`
    );
  }

  const start = Date.now();
  let rawText: string;
  let actualModel = provider.defaultModel;

  switch (provider.id) {
    case 'gemini': {
      const geminiOut = await callGemini(options, provider.defaultModel);
      rawText = geminiOut.text;
      actualModel = geminiOut.modelUsed;
      break;
    }
    case 'hermes':
      rawText = await callHermesGateway(options, provider.defaultModel);
      break;
    case 'openai':
      rawText = await callOpenAICompatible(options, provider.defaultModel);
      break;
    case 'anthropic':
      rawText = await callAnthropic(options, provider.defaultModel);
      break;
    case 'ollama':
      rawText = await callOllama(options, provider.defaultModel);
      break;
    default:
      throw new Error(`Unsupported LLM provider: ${provider.id}`);
  }

  const latencyMs = Date.now() - start;
  const data = options.jsonSchema
    ? (extractJsonObject(rawText) as T)
    : (rawText.trim() as T);

  return {
    data,
    providerId: provider.id,
    providerLabel: provider.label,
    model: actualModel,
    latencyMs,
  };
}
