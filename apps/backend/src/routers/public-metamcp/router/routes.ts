import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

import { mcpServerPool } from "@/lib/metamcp/mcp-server-pool";
import { SessionLifetimeManagerImpl } from "@/lib/session-lifetime-manager";
import {
  callRouterTool,
  createToolRouterServer,
  getRouterTools,
} from "@/lib/tool-router";
import {
  ApiKeyAuthenticatedRequest,
  authenticateApiKey,
} from "@/middleware/api-key-oauth.middleware";
import { lookupEndpoint } from "@/middleware/lookup-endpoint-middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { generateOpenApiSchema } from "@/routers/public-metamcp/openapi/schema-generator";
import logger from "@/utils/logger";

const toolRouter = express.Router();
const sessionManager =
  new SessionLifetimeManagerImpl<StreamableHTTPServerTransport>(
    "ToolRouterStreamableHTTP",
  );

const cleanupSession = async (
  sessionId: string,
  transport?: StreamableHTTPServerTransport,
) => {
  const sessionTransport = transport || sessionManager.getSession(sessionId);
  if (sessionTransport) {
    await sessionTransport.close();
  }
  sessionManager.removeSession(sessionId);
  await mcpServerPool.cleanupSession(sessionId);
};

toolRouter.get(
  "/:endpoint_name/router/api/openapi.json",
  lookupEndpoint,
  authenticateApiKey,
  async (req, res) => {
    const { namespaceUuid, endpointName } = req as ApiKeyAuthenticatedRequest;

    try {
      const sessionId = `router_openapi_${namespaceUuid}`;
      const tools = await getRouterTools(namespaceUuid, sessionId);
      const schema = await generateOpenApiSchema(
        tools,
        `${endpointName} Router`,
      );
      res.json(schema);
    } catch (error) {
      logger.error("Error generating router OpenAPI schema:", error);
      res.status(500).json({
        error: "Internal server error",
        message: "Failed to generate router OpenAPI schema",
        timestamp: new Date().toISOString(),
      });
    }
  },
);

toolRouter.post(
  "/:endpoint_name/router/api/:tool_name",
  express.json({ limit: "50mb" }),
  lookupEndpoint,
  authenticateApiKey,
  async (req, res) => {
    const { namespaceUuid } = req as ApiKeyAuthenticatedRequest;
    const toolName = req.params.tool_name;

    try {
      const result = await callRouterTool(
        namespaceUuid,
        `router_openapi_${namespaceUuid}`,
        toolName,
        req.body || {},
      );

      if (result.isError) {
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (error) {
      logger.error(`Error executing router tool ${toolName}:`, error);
      res.status(500).json({
        error: "Tool execution failed",
        message: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      });
    }
  },
);

toolRouter.get(
  "/:endpoint_name/router/api/:tool_name",
  lookupEndpoint,
  authenticateApiKey,
  async (req, res) => {
    const { namespaceUuid } = req as ApiKeyAuthenticatedRequest;
    const toolName = req.params.tool_name;

    try {
      const result = await callRouterTool(
        namespaceUuid,
        `router_openapi_${namespaceUuid}`,
        toolName,
        {},
      );

      if (result.isError) {
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (error) {
      logger.error(`Error executing router tool ${toolName}:`, error);
      res.status(500).json({
        error: "Tool execution failed",
        message: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      });
    }
  },
);

toolRouter.get(
  "/:endpoint_name/router/mcp",
  lookupEndpoint,
  authenticateApiKey,
  rateLimitMiddleware,
  async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;

    try {
      const transport = sessionManager.getSession(sessionId);
      if (!transport) {
        res.status(404).end("Session not found");
        return;
      }
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error("Error in router /mcp GET route:", error);
      res.status(500).json(error);
    }
  },
);

toolRouter.post(
  "/:endpoint_name/router/mcp",
  lookupEndpoint,
  authenticateApiKey,
  rateLimitMiddleware,
  async (req, res) => {
    const { namespaceUuid, endpointName } = req as ApiKeyAuthenticatedRequest;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      if (!sessionId) {
        const newSessionId = randomUUID();
        const server = createToolRouterServer(namespaceUuid, newSessionId);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
        });

        sessionManager.addSession(newSessionId, transport);
        logger.info(
          `Tool router session ${newSessionId} created for endpoint ${endpointName} -> namespace ${namespaceUuid}`,
        );

        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      const transport = sessionManager.getSession(sessionId);
      if (!transport) {
        res.status(404).json({
          error: "Session not found",
          message: `Transport not found for sessionId ${sessionId}`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error("Error in router /mcp POST route:", error);
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
        endpoint: endpointName,
        timestamp: new Date().toISOString(),
      });
    }
  },
);

toolRouter.delete(
  "/:endpoint_name/router/mcp",
  lookupEndpoint,
  authenticateApiKey,
  rateLimitMiddleware,
  async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId) {
      res.status(400).json({
        error: "Missing sessionId",
        message: "sessionId header is required for cleanup",
      });
      return;
    }

    try {
      await cleanupSession(sessionId);
      res.status(200).json({
        message: "Session cleaned up successfully",
        sessionId,
      });
    } catch (error) {
      logger.error("Error in router /mcp DELETE route:", error);
      res.status(500).json({
        error: "Cleanup failed",
        message: error instanceof Error ? error.message : "Unknown error",
        sessionId,
      });
    }
  },
);

sessionManager.startCleanupTimer(async (sessionId, transport) => {
  await cleanupSession(sessionId, transport);
});

export default toolRouter;
