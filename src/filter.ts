import picomatch from 'picomatch';
import type { Profile } from './config.js';
import type { RouteEntry } from './catalog.js';

export interface Requirements {
  textOutput: boolean;
  imageInput: boolean;
  documentInput: boolean;
  toolCalling: boolean;
  toolChoice: boolean;
  structuredOutputs: boolean;
  streaming: boolean;
  reasoning: boolean;
  zdr: boolean;
}

export function emptyRequirements(): Requirements {
  return {
    textOutput: true,
    imageInput: false,
    documentInput: false,
    toolCalling: false,
    toolChoice: false,
    structuredOutputs: false,
    streaming: false,
    reasoning: false,
    zdr: false,
  };
}

export function inferRequirements(body: any, profile: Profile): Requirements {
  const req: Requirements = {
    textOutput: true,
    imageInput: false,
    documentInput: false,
    toolCalling: false,
    toolChoice: false,
    structuredOutputs: false,
    streaming: false,
    reasoning: profile.requires.includes('reasoning'),
    zdr: profile.requires.includes('zdr'),
  };

  const messages = body.messages || [];

  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === 'string') {
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'image_url') {
          req.imageInput = true;
        }
        if (part.type === 'file' || part.type === 'document' || part.type === 'pdf') {
          req.documentInput = true;
        }
      }
    }
  }

  if (body.tools && body.tools.length > 0) {
    req.toolCalling = true;
  }

  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc === 'required' || tc === 'auto' || (typeof tc === 'object' && tc.type === 'function')) {
      req.toolChoice = true;
    }
  }

  if (body.response_format) {
    const rf = body.response_format;
    if (rf.type === 'json_object' || rf.type === 'json_schema') {
      req.structuredOutputs = true;
    }
  }

  if (body.stream === true) {
    req.streaming = true;
  }

  if (profile.requires.includes('image_input')) {
    req.imageInput = true;
  }

  return req;
}

interface EliminationCounts {
  capability: number;
  contextWindow: number;
  maxOutputTokens: number;
  denyGlob: number;
  priceFloor: number;
  tier: number;
  passed: number;
}

function emptyCounts(): EliminationCounts {
  return {
    capability: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
    denyGlob: 0,
    priceFloor: 0,
    tier: 0,
    passed: 0,
  };
}

export interface RankedCandidate {
  route: RouteEntry;
  estimatedCost: number;
  rank: number;
}

export function filterAndRank(
  candidates: RouteEntry[],
  req: Requirements,
  profile: Profile,
  promptTokens: number,
  outputCeiling: number,
  outputExpected: number,
): { ranked: RankedCandidate[]; counts: EliminationCounts } {
  const counts = emptyCounts();
  const denyMatchers = profile.deny.map(d => picomatch(d, { dot: true }));

  const filtered: { route: RouteEntry; cost: number }[] = [];

  for (const route of candidates) {
    if (req.textOutput && !route.capabilitiesOutput.includes('text')) { counts.capability++; continue; }
    if (req.imageInput && !route.capabilitiesInput.includes('image')) { counts.capability++; continue; }
    if (req.documentInput && !route.capabilitiesInput.includes('document')) { counts.capability++; continue; }
    if (req.toolCalling && !route.supports_tool_calling) { counts.capability++; continue; }
    if (req.toolChoice && !route.supports_tool_choice) { counts.capability++; continue; }
    if (req.structuredOutputs && !route.supports_structured_outputs) { counts.capability++; continue; }
    if (req.streaming && !route.supports_streaming) { counts.capability++; continue; }
    if (req.reasoning && !route.supports_reasoning) { counts.capability++; continue; }
    if (req.zdr && !route.zero_data_retention) { counts.capability++; continue; }

    if (promptTokens + outputCeiling > route.contextWindow) { counts.contextWindow++; continue; }
    if (outputCeiling > route.maxOutputTokens) { counts.maxOutputTokens++; continue; }

    if (denyMatchers.length > 0) {
      const allNames = [route.model, ...route.aliases];
      const denied = allNames.some(name => denyMatchers.some(m => m(name)));
      if (denied) { counts.denyGlob++; continue; }
    }

    if (profile.minInputPerMillion > 0 && route.inputPerMillion < profile.minInputPerMillion) {
      counts.priceFloor++; continue;
    }

    if (route.tier === 'priority') { counts.tier++; continue; }
    if (route.tier === 'flex' && !profile.allowFlex) { counts.tier++; continue; }

    counts.passed++;

    const cost = (promptTokens / 1e6) * route.inputPerMillion + (outputExpected / 1e6) * route.outputPerMillion;
    filtered.push({ route, cost });
  }

  filtered.sort((a, b) => {
    if (a.cost !== b.cost) return a.cost - b.cost;
    if (b.route.contextWindow !== a.route.contextWindow) return b.route.contextWindow - a.route.contextWindow;
    const dateA = a.route.launchDate ? new Date(a.route.launchDate).getTime() : 0;
    const dateB = b.route.launchDate ? new Date(b.route.launchDate).getTime() : 0;
    if (dateB !== dateA) return dateB - dateA;
    const keyA = `${a.route.model}@${a.route.vendor}`;
    const keyB = `${b.route.model}@${b.route.vendor}`;
    return keyA.localeCompare(keyB);
  });

  const ranked = filtered.map((f, i) => ({
    route: f.route,
    estimatedCost: f.cost,
    rank: i + 1,
  }));

  return { ranked, counts };
}
