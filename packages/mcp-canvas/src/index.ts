#!/usr/bin/env node
/**
 * Local stdio MCP server exposing read-only Canvas tools to Claude Code.
 * Reads CANVAS_BASE_URL / CANVAS_TOKEN from the environment (pass `--env-file=<repo>/.env`
 * to node so the token lives only in .env). stdout is the MCP channel: log to stderr only.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CanvasClient } from '@planner/canvas';
import { createCanvasMcpServer } from './server';

const baseUrl = process.env.CANVAS_BASE_URL?.trim();
const token = process.env.CANVAS_TOKEN?.trim();
const client = baseUrl && token ? new CanvasClient({ baseUrl, token }) : null;
if (!client)
  console.error('planner-canvas: CANVAS_BASE_URL/CANVAS_TOKEN not set; tools will report this.');

await createCanvasMcpServer(client).connect(new StdioServerTransport());
