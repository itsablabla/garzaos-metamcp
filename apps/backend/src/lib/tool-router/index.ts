import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequest,
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequest,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { metaMcpServerPool } from "@/lib/metamcp/metamcp-server-pool";
import { createMiddlewareEnabledHandlers } from "@/routers/public-metamcp/openapi/handlers";
import logger from "@/utils/logger";

type ToolInputSchema = Tool["inputSchema"];

type ToolGroup = {
  brand: string;
  tools: Tool[];
};

type RouterCacheEntry = {
  expiresAt: number;
  groups: Map<string, ToolGroup>;
  lastRefreshError?: string;
  lastRefreshFailedAt?: number;
  stale?: boolean;
  tools: Tool[];
};

type RouterCallArgs = {
  intent?: string;
  arguments?: Record<string, unknown>;
  tool?: string;
  mode?: "discover" | "schema" | "execute" | "auto";
  limit?: number;
};

type ToolLookupResult =
  | { status: "found"; tool: Tool }
  | { status: "not_found" }
  | { status: "ambiguous"; matchingTools: Tool[] };

const CACHE_TTL_MS = 60_000;
const ROUTER_DISCOVERY_TIMEOUT_MS = 10_000;
const ROUTER_EXECUTION_TIMEOUT_MS = 25_000;
const cache = new Map<string, RouterCacheEntry>();
const refreshes = new Map<string, Promise<RouterCacheEntry>>();

const brandToolInputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      description: "Natural language task or use case for this brand.",
    },
    arguments: {
      type: "object",
      description: "Arguments to pass to the selected downstream tool.",
      additionalProperties: true,
    },
    tool: {
      type: "string",
      description:
        "Optional explicit downstream tool name, with or without the brand prefix.",
    },
    mode: {
      type: "string",
      enum: ["discover", "schema", "execute", "auto"],
      default: "auto",
      description:
        "discover returns candidates, schema returns schemas, execute/auto may execute a selected tool.",
    },
    limit: {
      type: "number",
      description: "Maximum number of discovery results to return.",
    },
  },
};

const genericRouterTools: Tool[] = [
  {
    name: "search_brands",
    description:
      "Search available MCP brands in this endpoint namespace and optionally include matching downstream tools.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        includeTools: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "get_brand_tools",
    description:
      "Return downstream tool names, descriptions, and input schemas for a brand.",
    inputSchema: {
      type: "object",
      properties: {
        brand: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["brand"],
    },
  },
  {
    name: "get_tool_schema",
    description: "Return the input schema for one explicit downstream tool.",
    inputSchema: {
      type: "object",
      properties: {
        brand: { type: "string" },
        tool: { type: "string" },
      },
      required: ["tool"],
    },
  },
  {
    name: "execute_tool",
    description: "Execute one explicit downstream tool by brand and tool name.",
    inputSchema: {
      type: "object",
      properties: {
        brand: { type: "string" },
        tool: { type: "string" },
        arguments: {
          type: "object",
          additionalProperties: true,
        },
      },
      required: ["tool"],
    },
  },
];

const genericRouterToolNames = new Set(
  genericRouterTools.map((tool) => tool.name),
);

const normalizeBrand = (brand: string) => brand.trim().toLowerCase();

const getBrandFromToolName = (toolName: string): string | null => {
  const separatorIndex = toolName.indexOf("__");
  if (separatorIndex <= 0) return null;
  return normalizeBrand(toolName.slice(0, separatorIndex));
};

const stripBrandPrefix = (toolName: string): string => {
  const separatorIndex = toolName.indexOf("__");
  return separatorIndex === -1 ? toolName : toolName.slice(separatorIndex + 2);
};

const jsonResult = (payload: unknown, isError = false): CallToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(payload, null, 2),
    },
  ],
  isError,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const staleCacheEntry = (
  entry: RouterCacheEntry,
  error: unknown,
): RouterCacheEntry => ({
  ...entry,
  expiresAt: Date.now() + CACHE_TTL_MS,
  lastRefreshError: errorMessage(error),
  lastRefreshFailedAt: Date.now(),
  stale: true,
});

const summarizeTool = (tool: Tool) => ({
  name: tool.name,
  shortName: stripBrandPrefix(tool.name),
  description: tool.description || "",
  inputSchema: tool.inputSchema || { type: "object", properties: {} },
});

const getSchemaPropertyNames = (schema: unknown): string[] => {
  if (!schema || typeof schema !== "object") return [];
  const objectSchema = schema as Record<string, unknown>;
  const names: string[] = [];
  const properties = objectSchema.properties;
  if (properties && typeof properties === "object") {
    for (const [name, value] of Object.entries(properties)) {
      names.push(name);
      names.push(...getSchemaPropertyNames(value));
    }
  }
  return names;
};

const tokensFrom = (value: unknown): Set<string> => {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 2),
  );
};

const toolSearchText = (tool: Tool): string =>
  [
    tool.name,
    stripBrandPrefix(tool.name),
    tool.description || "",
    ...getSchemaPropertyNames(tool.inputSchema),
  ].join(" ");

const filterTools = (tools: Tool[], query?: string, limit = 20): Tool[] => {
  const normalizedQuery = query?.trim().toLowerCase();
  const filtered = normalizedQuery
    ? tools.filter((tool) =>
        toolSearchText(tool).toLowerCase().includes(normalizedQuery),
      )
    : tools;
  return filtered.slice(0, Math.max(1, limit));
};

const findTool = (
  groups: Map<string, ToolGroup>,
  toolName: string,
  brand?: string,
): ToolLookupResult => {
  const normalizedBrand = brand ? normalizeBrand(brand) : undefined;
  const candidates = normalizedBrand
    ? groups.get(normalizedBrand)?.tools || []
    : Array.from(groups.values()).flatMap((group) => group.tools);
  const normalizedToolName = toolName.trim().toLowerCase();

  if (!normalizedToolName) return { status: "not_found" };

  if (normalizedToolName.includes("__")) {
    const fullNameMatch = candidates.find(
      (tool) => tool.name.toLowerCase() === normalizedToolName,
    );
    return fullNameMatch
      ? { status: "found", tool: fullNameMatch }
      : { status: "not_found" };
  }

  const shortNameMatches = candidates.filter(
    (tool) => stripBrandPrefix(tool.name).toLowerCase() === normalizedToolName,
  );

  if (shortNameMatches.length === 1) {
    return { status: "found", tool: shortNameMatches[0] };
  }

  if (shortNameMatches.length > 1) {
    return { status: "ambiguous", matchingTools: shortNameMatches };
  }

  return { status: "not_found" };
};

const getBrandToolNameMap = (
  groups: Map<string, ToolGroup>,
): Map<string, string> => {
  const usedToolNames = new Set(genericRouterToolNames);
  const brandToolNameMap = new Map<string, string>();

  for (const brand of Array.from(groups.keys()).sort()) {
    const preferredName = genericRouterToolNames.has(brand)
      ? `brand_${brand}`
      : brand;
    let toolName = preferredName;
    let suffix = 2;

    while (usedToolNames.has(toolName)) {
      toolName = `${preferredName}_${suffix}`;
      suffix += 1;
    }

    usedToolNames.add(toolName);
    brandToolNameMap.set(brand, toolName);
  }

  return brandToolNameMap;
};

const getBrandForRouterToolName = (
  groups: Map<string, ToolGroup>,
  toolName: string,
): string | undefined => {
  const brandToolNameMap = getBrandToolNameMap(groups);
  const normalizedToolName = normalizeBrand(toolName);

  for (const [brand, routerToolName] of brandToolNameMap.entries()) {
    if (routerToolName === normalizedToolName) return brand;
  }

  return undefined;
};

const matchTools = (tools: Tool[], intent?: string, limit = 10): Tool[] => {
  if (!intent?.trim()) return tools.slice(0, Math.max(1, limit));

  const queryTokens = tokensFrom(intent);
  const scored = tools
    .map((tool) => {
      const searchTokens = tokensFrom(toolSearchText(tool));
      let score = 0;
      for (const token of queryTokens) {
        if (searchTokens.has(token)) score += 1;
      }
      if (toolSearchText(tool).toLowerCase().includes(intent.toLowerCase())) {
        score += 3;
      }
      return { tool, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, Math.max(1, limit)).map(({ tool }) => tool);
};

const selectSingleStrongMatch = (
  tools: Tool[],
  intent?: string,
): Tool | undefined => {
  if (!intent?.trim()) return undefined;

  const queryTokens = tokensFrom(intent);
  const scored = tools
    .map((tool) => {
      const searchText = toolSearchText(tool).toLowerCase();
      const searchTokens = tokensFrom(searchText);
      let score = 0;
      for (const token of queryTokens) {
        if (searchTokens.has(token)) score += 1;
      }
      if (searchText.includes(intent.toLowerCase())) score += 3;
      return { tool, score };
    })
    .filter(({ score }) => score >= 2)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1) return scored[0].tool;
  if (scored.length > 1 && scored[0].score >= scored[1].score + 2) {
    return scored[0].tool;
  }
  return undefined;
};

const buildGroups = (tools: Tool[]): Map<string, ToolGroup> => {
  const groups = new Map<string, ToolGroup>();

  for (const tool of tools) {
    const brand = getBrandFromToolName(tool.name);
    if (!brand) continue;
    const group = groups.get(brand) || { brand, tools: [] };
    group.tools.push(tool);
    groups.set(brand, group);
  }

  return groups;
};

const buildCacheEntry = (
  tools: Tool[],
  previousEntry?: RouterCacheEntry,
): RouterCacheEntry => {
  const groups = buildGroups(tools);

  if (previousEntry) {
    for (const [brand, group] of previousEntry.groups.entries()) {
      if (!groups.has(brand)) {
        groups.set(brand, group);
      }
    }
  }

  return {
    expiresAt: Date.now() + CACHE_TTL_MS,
    groups,
    tools: Array.from(groups.values()).flatMap((group) => group.tools),
  };
};

const refreshRouterToolGroups = (
  namespaceUuid: string,
  sessionId: string,
  previousEntry?: RouterCacheEntry,
): Promise<RouterCacheEntry> => {
  const refresh = withTimeout(
    (async () => {
      await metaMcpServerPool.getOpenApiServer(namespaceUuid);

      const { handlerContext, listToolsWithMiddleware } =
        createMiddlewareEnabledHandlers(sessionId, namespaceUuid);
      const request: ListToolsRequest = { method: "tools/list", params: {} };
      const result = await listToolsWithMiddleware(request, handlerContext);
      return result.tools || [];
    })(),
    ROUTER_DISCOVERY_TIMEOUT_MS,
    `Router discovery for namespace ${namespaceUuid}`,
  )
    .then((tools) => {
      const entry = buildCacheEntry(tools, previousEntry);
      cache.set(namespaceUuid, entry);
      return entry;
    })
    .catch((error) => {
      logger.error(
        `Router discovery failed for namespace ${namespaceUuid}:`,
        error,
      );

      const latestCached = cache.get(namespaceUuid) || previousEntry;
      if (latestCached) {
        const staleEntry = staleCacheEntry(latestCached, error);
        cache.set(namespaceUuid, staleEntry);
        return staleEntry;
      }

      const emptyEntry: RouterCacheEntry = {
        expiresAt: Date.now() + CACHE_TTL_MS,
        groups: new Map(),
        lastRefreshError: errorMessage(error),
        lastRefreshFailedAt: Date.now(),
        stale: true,
        tools: [],
      };
      cache.set(namespaceUuid, emptyEntry);
      return emptyEntry;
    })
    .finally(() => {
      refreshes.delete(namespaceUuid);
    });

  refreshes.set(namespaceUuid, refresh);
  return refresh;
};

export const getRouterToolGroups = async (
  namespaceUuid: string,
  sessionId: string,
  bypassCache = false,
): Promise<RouterCacheEntry> => {
  const cached = cache.get(namespaceUuid);
  if (!bypassCache && cached && cached.expiresAt > Date.now()) return cached;

  const existingRefresh = refreshes.get(namespaceUuid);
  if (existingRefresh) {
    if (cached) return cached;
    return await existingRefresh;
  }

  const refresh = refreshRouterToolGroups(namespaceUuid, sessionId, cached);
  if (!bypassCache && cached) {
    return {
      ...cached,
      stale: true,
    };
  }

  return await refresh;
};

export const getRouterTools = async (
  namespaceUuid: string,
  sessionId: string,
): Promise<Tool[]> => {
  const { groups } = await getRouterToolGroups(namespaceUuid, sessionId);
  const brandToolNameMap = getBrandToolNameMap(groups);
  const brandTools: Tool[] = Array.from(groups.values())
    .sort((a, b) => a.brand.localeCompare(b.brand))
    .map((group) => ({
      name: brandToolNameMap.get(group.brand) || group.brand,
      description: `${group.brand} router for ${group.tools.length} downstream tool${group.tools.length === 1 ? "" : "s"}. Provide intent and optional arguments/tool/mode to discover schemas or execute a matching downstream tool.`,
      inputSchema: brandToolInputSchema,
    }));

  return [...brandTools, ...genericRouterTools];
};

const executeDownstreamTool = async (
  namespaceUuid: string,
  sessionId: string,
  tool: Tool,
  args?: Record<string, unknown>,
): Promise<CallToolResult> => {
  const { handlerContext, callToolWithMiddleware } =
    createMiddlewareEnabledHandlers(sessionId, namespaceUuid);
  const request: CallToolRequest = {
    method: "tools/call",
    params: {
      name: tool.name,
      arguments: args || {},
    },
  };
  try {
    return await withTimeout(
      callToolWithMiddleware(request, handlerContext),
      ROUTER_EXECUTION_TIMEOUT_MS,
      `Router execution for tool ${tool.name}`,
    );
  } catch (error) {
    logger.error(`Router execution failed for tool ${tool.name}:`, error);
    return jsonResult(
      {
        error: "Tool execution failed",
        message: errorMessage(error),
        tool: tool.name,
      },
      true,
    );
  }
};

const handleBrandTool = async (
  namespaceUuid: string,
  sessionId: string,
  brand: string,
  args: RouterCallArgs,
): Promise<CallToolResult> => {
  const { groups } = await getRouterToolGroups(namespaceUuid, sessionId);
  const normalizedBrand = normalizeBrand(brand);
  const group = groups.get(normalizedBrand);

  if (!group) {
    return jsonResult(
      {
        needs_selection: true,
        brand: normalizedBrand,
        matching_tools: [],
        error: `Brand '${brand}' is not available in this endpoint namespace.`,
      },
      true,
    );
  }

  const mode = args.mode || "auto";
  const limit = args.limit || 10;
  const explicitToolResult = args.tool
    ? findTool(groups, args.tool, normalizedBrand)
    : ({ status: "not_found" } as ToolLookupResult);
  const explicitTool =
    explicitToolResult.status === "found" ? explicitToolResult.tool : undefined;

  if (args.tool && !explicitTool) {
    return jsonResult(
      {
        needs_selection: true,
        brand: normalizedBrand,
        matching_tools: filterTools(group.tools, args.tool, limit).map(
          summarizeTool,
        ),
        error: `Tool '${args.tool}' was not found for brand '${brand}'.`,
      },
      true,
    );
  }

  if (mode === "discover") {
    return jsonResult({
      needs_selection: true,
      brand: normalizedBrand,
      matching_tools: filterTools(group.tools, args.intent, limit).map(
        summarizeTool,
      ),
    });
  }

  if (mode === "schema") {
    const schemaTools = explicitTool
      ? [explicitTool]
      : matchTools(group.tools, args.intent, limit);
    return jsonResult({
      brand: normalizedBrand,
      tools: schemaTools.map(summarizeTool),
    });
  }

  const selectedTool =
    explicitTool || selectSingleStrongMatch(group.tools, args.intent);
  if (!selectedTool) {
    return jsonResult({
      needs_selection: true,
      brand: normalizedBrand,
      matching_tools: matchTools(group.tools, args.intent, limit).map(
        summarizeTool,
      ),
    });
  }

  return await executeDownstreamTool(
    namespaceUuid,
    sessionId,
    selectedTool,
    args.arguments,
  );
};

export const callRouterTool = async (
  namespaceUuid: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> => {
  const { groups } = await getRouterToolGroups(namespaceUuid, sessionId);

  if (toolName === "search_brands") {
    const query =
      typeof args.query === "string" ? args.query.toLowerCase() : "";
    const includeTools = args.includeTools === true;
    const brands = Array.from(groups.values())
      .filter(
        (group) =>
          !query ||
          group.brand.includes(query) ||
          group.tools.some((tool) =>
            toolSearchText(tool).toLowerCase().includes(query),
          ),
      )
      .sort((a, b) => a.brand.localeCompare(b.brand))
      .map((group) => ({
        brand: group.brand,
        tool_count: group.tools.length,
        tools: includeTools
          ? filterTools(group.tools, query || undefined, 10).map(summarizeTool)
          : undefined,
      }));
    return jsonResult({ brands });
  }

  if (toolName === "get_brand_tools") {
    const brand =
      typeof args.brand === "string" ? normalizeBrand(args.brand) : "";
    const group = groups.get(brand);
    if (!group) {
      return jsonResult(
        { brand, tools: [], error: `Brand '${brand}' not found.` },
        true,
      );
    }
    return jsonResult({
      brand,
      tools: filterTools(
        group.tools,
        typeof args.query === "string" ? args.query : undefined,
        typeof args.limit === "number" ? args.limit : 50,
      ).map(summarizeTool),
    });
  }

  if (toolName === "get_tool_schema") {
    const toolResult = findTool(
      groups,
      String(args.tool || ""),
      typeof args.brand === "string" ? args.brand : undefined,
    );

    if (toolResult.status === "ambiguous") {
      return jsonResult(
        {
          needs_brand: true,
          error: `Tool '${String(args.tool || "")}' is ambiguous. Provide brand or use a fully-qualified tool name.`,
          matching_tools: toolResult.matchingTools.map(summarizeTool),
        },
        true,
      );
    }

    if (toolResult.status === "not_found") {
      return jsonResult(
        { error: `Tool '${String(args.tool || "")}' not found.` },
        true,
      );
    }
    return jsonResult({ tool: summarizeTool(toolResult.tool) });
  }

  if (toolName === "execute_tool") {
    const toolResult = findTool(
      groups,
      String(args.tool || ""),
      typeof args.brand === "string" ? args.brand : undefined,
    );

    if (toolResult.status === "ambiguous") {
      return jsonResult(
        {
          needs_brand: true,
          error: `Tool '${String(args.tool || "")}' is ambiguous. Provide brand or use a fully-qualified tool name.`,
          matching_tools: toolResult.matchingTools.map(summarizeTool),
        },
        true,
      );
    }

    if (toolResult.status === "not_found") {
      return jsonResult(
        { error: `Tool '${String(args.tool || "")}' not found.` },
        true,
      );
    }
    return await executeDownstreamTool(
      namespaceUuid,
      sessionId,
      toolResult.tool,
      (args.arguments as Record<string, unknown> | undefined) || {},
    );
  }

  const brandToolName = getBrandForRouterToolName(groups, toolName);
  if (brandToolName) {
    return await handleBrandTool(
      namespaceUuid,
      sessionId,
      brandToolName,
      args as RouterCallArgs,
    );
  }

  logger.warn(`Unknown router tool requested: ${toolName}`);
  return jsonResult({ error: `Unknown router tool: ${toolName}` }, true);
};

export const createToolRouterServer = (
  namespaceUuid: string,
  sessionId: string,
) => {
  const server = new Server(
    {
      name: `metamcp-router-${namespaceUuid}`,
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await getRouterTools(namespaceUuid, sessionId),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await callRouterTool(
      namespaceUuid,
      sessionId,
      request.params.name,
      (request.params.arguments as Record<string, unknown> | undefined) || {},
    );
  });

  return server;
};
