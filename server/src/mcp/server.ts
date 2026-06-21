import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Ctx, Decision } from "../types.js";
import {
  recallDecisions,
  recordDecision,
  getDecision,
  listDecisions,
  supersedeDecision,
} from "../core/memory.js";
import { checkConflict } from "../core/review.js";
import {
  startBootstrap,
  getBootstrapStatus,
  readRepoSummary,
} from "../core/bootstrap.js";
import {
  formatDecisionsForAgent,
  formatConflictsForAgent,
} from "../scripts/format.js";

/**
 * Build a fully-wired MCP server bound to a single request {@link Ctx}.
 * Used by both transports: stdio (local spawn) and Streamable HTTP (remote).
 * Tool descriptions deliberately nudge agents to recall BEFORE writing code.
 */
/** Render unscored decisions (list/get) — `formatDecisionsForAgent` expects similarity. */
function renderDecisions(decisions: Decision[]): string {
  if (decisions.length === 0) return "No decisions found.";
  return decisions
    .map((d) => {
      const scope = d.repo_id ? ` (${d.repo_id})` : "";
      const why = d.rationale ? ` — ${d.rationale}` : "";
      return `- [${d.id}] (${d.status})${scope} ${d.statement}${why}`;
    })
    .join("\n");
}

export function buildMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "ares", version: "2.0.0" });

  server.registerTool(
    "ensure_repo_memory",
    {
      title: "Bootstrap repo decision memory",
      description:
        "Call this ONCE at the start of working in a repo, BEFORE your first recall_decisions. Returns immediately. If ARES has no decisions for this repo yet, it kicks off a BACKGROUND mine from the repo's docs and PR review comments (code-anchored) — recall improves over the next ~30-60s and a markdown summary is written. Idempotent: instant no-op if already populated. Pass repo as 'owner/repo' (lowercase). Set deep:true for a thorough mine.",
      inputSchema: {
        repo: z.string(),
        deep: z.boolean().optional(),
      },
    },
    async ({ repo, deep }) => {
      const r = await startBootstrap(repo, { deep }, ctx);
      const msg =
        r.status === "ready"
          ? `Repo "${r.repo_id}" memory is ready (${r.existing} decisions). Proceed.`
          : r.started
            ? `Started bootstrapping "${r.repo_id}" in the background (~30-60s). You can proceed; recall will improve as decisions land, and a summary doc is being written.`
            : `Bootstrap for "${r.repo_id}" already in progress. Proceed; recall improves as it completes.`;
      return { content: [{ type: "text", text: msg }], structuredContent: r };
    },
  );

  server.registerTool(
    "get_repo_summary",
    {
      title: "Get repo conventions summary",
      description:
        "Return the markdown digest of a repo's mined conventions (themed groups of decisions). Useful as orientation context. Pass repo as 'owner/repo'.",
      inputSchema: { repo: z.string() },
    },
    async ({ repo }) => {
      const md = await readRepoSummary(repo);
      const status = await getBootstrapStatus(repo, ctx);
      return {
        content: [
          {
            type: "text",
            text: md ?? `No summary yet for ${repo} (status: ${status.status}, ${status.count} decisions).`,
          },
        ],
        structuredContent: { repo_id: repo.toLowerCase(), markdown: md, status },
      };
    },
  );

  server.registerTool(
    "recall_decisions",
    {
      title: "Recall team decisions",
      description:
        "BEFORE writing code, search the team's past engineering decisions for this repo by meaning. Call this whenever you are about to implement something that might have an established convention (auth, caching, IDs, retries, error handling, dependencies, logging, migrations). Treat a high-similarity result as binding context you must respect, and cite it as [decision_id].",
      inputSchema: {
        query: z.string(),
        repo: z.string().optional(),
        limit: z.number().int().min(1).max(20).default(5),
      },
    },
    async ({ query, repo, limit }) => {
      const results = await recallDecisions(query, { repo_id: repo, limit }, ctx);
      return {
        content: [{ type: "text", text: formatDecisionsForAgent(results) }],
        structuredContent: { decisions: results },
      };
    },
  );

  server.registerTool(
    "check_conflict",
    {
      title: "Check code against memory",
      description:
        "AFTER drafting code, check whether it conflicts with a past decision. Pass the snippet or diff you just wrote. Returns the violated decision(s) with reasoning and confidence so you can self-correct before the user ever sees the conflict.",
      inputSchema: {
        snippet: z.string().optional(),
        repo: z.string().optional(),
        intent: z.string().optional(),
      },
    },
    async ({ snippet, repo, intent }) => {
      const conflicts = await checkConflict(
        { snippet, repo_id: repo, intent },
        ctx,
      );
      return {
        content: [{ type: "text", text: formatConflictsForAgent(conflicts) }],
        structuredContent: { conflicts },
      };
    },
  );

  server.registerTool(
    "record_decision",
    {
      title: "Record a decision",
      description:
        "Persist a new engineering decision so future code (by any agent or human) respects it. Use this when the team establishes a rule, convention, or 'never do X again' lesson.",
      inputSchema: {
        statement: z.string(),
        rationale: z.string().optional(),
        repo: z.string().optional(),
        scope_globs: z.array(z.string()).optional(),
        context_code: z.string().optional(),
        source_url: z.string().optional(),
        author: z.string().optional(),
      },
    },
    async ({ repo, ...rest }) => {
      const decision = await recordDecision({ ...rest, repo_id: repo }, ctx);
      return {
        content: [{ type: "text", text: `Recorded decision ${decision.id}` }],
        structuredContent: { decision },
      };
    },
  );

  server.registerTool(
    "list_decisions",
    {
      title: "List decisions",
      description:
        "List the team's decisions, optionally filtered by repo and lifecycle status (active | superseded | deprecated). Useful to review the corpus or audit what governs a repo.",
      inputSchema: {
        repo: z.string().optional(),
        status: z.enum(["active", "superseded", "deprecated"]).optional(),
      },
    },
    async ({ repo, status }) => {
      const decisions = await listDecisions({ repo_id: repo, status }, ctx);
      return {
        content: [{ type: "text", text: renderDecisions(decisions) }],
        structuredContent: { decisions },
      };
    },
  );

  server.registerTool(
    "get_decision",
    {
      title: "Get a decision",
      description:
        "Fetch a single decision by its id, including its full rationale and lifecycle metadata.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const decision = await getDecision(id, ctx);
      return {
        content: [
          {
            type: "text",
            text: decision
              ? renderDecisions([decision])
              : `No decision found for ${id}`,
          },
        ],
        structuredContent: { decision },
      };
    },
  );

  server.registerTool(
    "supersede_decision",
    {
      title: "Supersede a decision",
      description:
        "Replace an existing decision with an updated one. The old decision is marked 'superseded' (excluded from recall) and the new one links back to it, preserving the audit lineage.",
      inputSchema: {
        id: z.string(),
        statement: z.string(),
        rationale: z.string().optional(),
        repo: z.string().optional(),
        scope_globs: z.array(z.string()).optional(),
        context_code: z.string().optional(),
        source_url: z.string().optional(),
        author: z.string().optional(),
      },
    },
    async ({ id, repo, ...rest }) => {
      const decision = await supersedeDecision(id, { ...rest, repo_id: repo }, ctx);
      return {
        content: [
          {
            type: "text",
            text: `Superseded ${id} with new decision ${decision.id}`,
          },
        ],
        structuredContent: { decision },
      };
    },
  );

  // Resources: let agents attach the corpus as context.
  server.registerResource(
    "decision",
    new ResourceTemplate("ares://decisions/{id}", { list: undefined }),
    {
      title: "ARES decision",
      description: "A single engineering decision by id.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
      const decision = await getDecision(String(id), ctx);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(decision ?? null, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "repo-decisions",
    new ResourceTemplate("ares://repo/{repo}/decisions", { list: undefined }),
    {
      title: "ARES repo decisions",
      description: "All active decisions scoped to a repo (owner/repo).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const repo = Array.isArray(variables.repo) ? variables.repo[0] : variables.repo;
      const decisions = await listDecisions(
        { repo_id: String(repo), status: "active" },
        ctx,
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(decisions, null, 2),
          },
        ],
      };
    },
  );

  return server;
}
