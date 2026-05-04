# GARZA OS MCP Agent Instructions

Use MetaMCP as the primary MCP entrypoint. Public MetaMCP endpoints require API-key auth.

## Primary MetaMCP endpoints

Use the dedicated brand router endpoints for reliability. The aggregate Default namespace includes slow/offline upstreams and may return a retryable discovery timeout.

Auth header for all MetaMCP requests:

```http
X-API-Key: sk_mt_UHhCj8J2zLtxSGK4GG0md3EN26Gi11c5LT81JDVYMrrXVHNZHdXzsmN9lNvTxugC
```

Dedicated Streamable HTTP MCP endpoints:

```json
{
  "mcpServers": {
    "metamcp-tavily": {
      "transport": "http",
      "url": "https://metamcp.garza.online/metamcp/tavily/router/mcp",
      "headers": { "X-API-Key": "sk_mt_UHhCj8J2zLtxSGK4GG0md3EN26Gi11c5LT81JDVYMrrXVHNZHdXzsmN9lNvTxugC" }
    },
    "metamcp-firecrawl": {
      "transport": "http",
      "url": "https://metamcp.garza.online/metamcp/firecrawl/router/mcp",
      "headers": { "X-API-Key": "sk_mt_UHhCj8J2zLtxSGK4GG0md3EN26Gi11c5LT81JDVYMrrXVHNZHdXzsmN9lNvTxugC" }
    },
    "metamcp-context7": {
      "transport": "http",
      "url": "https://metamcp.garza.online/metamcp/context7/router/mcp",
      "headers": { "X-API-Key": "sk_mt_UHhCj8J2zLtxSGK4GG0md3EN26Gi11c5LT81JDVYMrrXVHNZHdXzsmN9lNvTxugC" }
    },
    "metamcp-onepass": {
      "transport": "http",
      "url": "https://metamcp.garza.online/metamcp/onepass/router/mcp",
      "headers": { "X-API-Key": "sk_mt_UHhCj8J2zLtxSGK4GG0md3EN26Gi11c5LT81JDVYMrrXVHNZHdXzsmN9lNvTxugC" }
    },
    "metamcp-e2b": {
      "transport": "http",
      "url": "https://metamcp.garza.online/metamcp/e2b/router/mcp",
      "headers": { "X-API-Key": "sk_mt_UHhCj8J2zLtxSGK4GG0md3EN26Gi11c5LT81JDVYMrrXVHNZHdXzsmN9lNvTxugC" }
    },
    "metamcp-mem0": {
      "transport": "http",
      "url": "https://metamcp.garza.online/metamcp/mem0/router/mcp",
      "headers": { "X-API-Key": "sk_mt_UHhCj8J2zLtxSGK4GG0md3EN26Gi11c5LT81JDVYMrrXVHNZHdXzsmN9lNvTxugC" }
    },
    "metamcp-tailscale": {
      "transport": "http",
      "url": "https://metamcp.garza.online/metamcp/tailscale/router/mcp",
      "headers": { "X-API-Key": "sk_mt_UHhCj8J2zLtxSGK4GG0md3EN26Gi11c5LT81JDVYMrrXVHNZHdXzsmN9lNvTxugC" }
    },
    "metamcp-composio": {
      "transport": "http",
      "url": "https://metamcp.garza.online/metamcp/composio/router/mcp",
      "headers": { "X-API-Key": "sk_mt_UHhCj8J2zLtxSGK4GG0md3EN26Gi11c5LT81JDVYMrrXVHNZHdXzsmN9lNvTxugC" }
    },
    "metamcp-hyperbrowser": {
      "transport": "http",
      "url": "https://metamcp.garza.online/metamcp/hyperbrowser/router/mcp",
      "headers": { "X-API-Key": "sk_mt_UHhCj8J2zLtxSGK4GG0md3EN26Gi11c5LT81JDVYMrrXVHNZHdXzsmN9lNvTxugC" }
    },
    "metamcp-prompts-chat": {
      "transport": "http",
      "url": "https://metamcp.garza.online/metamcp/prompts-chat/router/mcp",
      "headers": { "X-API-Key": "sk_mt_UHhCj8J2zLtxSGK4GG0md3EN26Gi11c5LT81JDVYMrrXVHNZHdXzsmN9lNvTxugC" }
    }
  }
}
```

OpenAPI equivalents use `https://metamcp.garza.online/metamcp/<brand>/router/api/openapi.json` with the same `X-API-Key` header.

The aggregate endpoint exists but is not preferred until broken upstreams are removed from Default:

```json
{
  "mcpServers": {
    "metamcp-router-default": {
      "transport": "http",
      "url": "https://metamcp.garza.online/metamcp/default/router/mcp",
      "headers": { "X-API-Key": "sk_mt_UHhCj8J2zLtxSGK4GG0md3EN26Gi11c5LT81JDVYMrrXVHNZHdXzsmN9lNvTxugC" }
    }
  }
}
```

## Request preparation workflow

Before submitting any substantial request to another agent, MCP tool, automation, or external service:

1. Query the prompt database through `prompts-chat` for reusable prompts that match the task, domain, target tool, or desired output format.
2. If a relevant prompt exists, adapt it to the current request instead of drafting from scratch.
3. If no relevant prompt exists, use `prompts-chat` to improve/structure the request, then save the improved prompt when it is likely to be reusable.
4. Query the skills database through `prompts-chat` for available skills related to the task.
5. If a skill exists, read and follow it before acting.
6. If no skill exists but the task is recurring or specialized, use the skills MCP/database to create, download, or store a reusable skill for future agents, then proceed.
7. Do not block urgent or simple work indefinitely if `prompts-chat` is unavailable; continue with best effort and note the missed optimization opportunity.

## Router invocation pattern

The brand router exposes five meta-tools per endpoint:

- `<brand>` convenience router tool
- `search_brands`
- `get_brand_tools`
- `get_tool_schema`
- `execute_tool`

Do real work through `execute_tool`:

```json
{
  "brand": "tavily",
  "tool": "tavily_search",
  "arguments": { "query": "example" }
}
```

Do not call downstream prefixed tools such as `tavily__tavily_search` directly as router tool names; direct calls return `Unknown router tool`. Use `get_brand_tools` first to discover available downstream tool names, then pass the selected name to `execute_tool`.

## Tool selection policy

- Use `prompts-chat` as the prompt and skills database. Check it before every substantial request, not only ambiguous requests.
- Use `context7` before writing SDK/library/framework code. For `resolve-library-id`, provide both `query` and `libraryName`; the schema requires both even though the description can read like alternatives.
- Use `firecrawl` for static web search/scraping/extraction.
- Do not route browser automation through MetaMCP `hyperbrowser` right now: the catalog registers tools, but execution returns `Unknown tool` for `hyperbrowser__*`. Use `firecrawl`/`tavily` when sufficient, or connect to Hyperbrowser MCP directly outside MetaMCP until the router config is fixed.
- Use `tavily` for fast web search/research.
- Use `e2b` for sandboxed code execution. Cold starts can exceed the router execution timeout; pre-warm the sandbox or retry if the first `e2b__run_code` call times out.
- Use `onepass` for 1Password access. Always target vault `Main`; the current token only exposes `Main`.
- Use `tailscale` only for network administration tasks; treat it as high-risk.
- Use `composio` for broad SaaS/app connector discovery and execution.
- Use `mem0` for persistent memory operations.

## Known unreliable or environment-bound tools

- `beeper-local` and `beeper-oakhost` currently expose zero/unknown tools or depend on local network tunnels. Do not rely on them for critical flows.
- `hyperbrowser` through MetaMCP is currently broken for execution despite catalog discovery. Bypass MetaMCP for Hyperbrowser until fixed.
- `prompts-chat` may time out from the MetaMCP VM. It is still the required first choice for prompt/skill lookup, but do not let it block urgent work.
- Endpoints that reference `oakhost`, `100.121.182.67`, or local Beeper/Proton Bridge services may fail from cloud-hosted agents unless the relevant Tailscale tunnel is reachable.

## Streamable HTTP notes

- MCP Streamable HTTP endpoints expect POST and streaming/SSE response handling. A plain GET to `/router/mcp` returning 404 is expected.
- If `tools/list` appears to hang, confirm the client is consuming the streamed response correctly. Prefer brand router endpoints and second-wave `get_brand_tools`/schema calls.

## Security

- Never paste secrets into logs, PR descriptions, or user-facing summaries unless the user explicitly asks for configuration material.
- The MetaMCP API key above grants access to sensitive tools including 1Password and Tailscale. Scope client access carefully.
