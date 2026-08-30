import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Bundle } from "../src/bundle.mjs";
import { run } from "../src/cli.mjs";
import { recall } from "../src/recall.mjs";
import { fold } from "../src/fold.mjs";
import { projectIdFor } from "../src/project-id.mjs";
import { spawnDetached } from "../src/git.mjs";
import { readSettings, contextBlock, compactionFromSummary, summarizeCmd, snapshotIsStale } from "./pi-core.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "memory.mjs");
// fold's spawn argv turns every settings key into `--<key> <value>`; only these
// four are fold options, so anything else in the merged settings (dir,
// summaryModel) must never reach it.
const FOLD_SETTING_KEYS = ["observeAfterTokens", "reflectAfterTokens", "observationsMaxTokens", "observationsTargetTokens"] as const;
function foldSettings(settings: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of FOLD_SETTING_KEYS) if (settings[k] !== undefined) out[k] = settings[k];
  return out;
}

export default function memory(pi: ExtensionAPI): void {
  if ((process.env.MEMORY ?? "on") === "off") return;
  let snapshot = "";
  let snapshotCapturedAt = 0;
  let settings: any = {};
  let bundle: Bundle;
  const session = (ctx: any) => `pi:session/${ctx.sessionManager.getSessionId()}`;
  // Actors are "<producer>/<version>" with no slash inside <version> (see
  // src/actor.mjs); a model id that itself contains a slash (e.g. a
  // clinepass model id "cline-pass/deepseek-v4-flash") would otherwise
  // produce an actor with two slashes and get refused on every write.
  const actor = (ctx: any) => `pi/${(ctx.model?.id ?? "unknown").replace(/\//g, ":")}`;
  const refresh = (ctx: any) => {
    try { snapshot = bundle.exists() ? contextBlock(bundle, ctx.cwd, session(ctx)) : ""; } catch { snapshot = ""; }
    snapshotCapturedAt = Date.now();
  };
  // Never touches process.stdout/stderr: run() collects output into strings,
  // so concurrent tool calls (pi's default parallel tool execution) can't
  // race a shared stream monkeypatch.
  const cli = async (ctx: any, args: string[], stdin = "") => {
    const r = await run(["--dir", bundle.root, "--cwd", ctx.cwd, "--actor", actor(ctx), ...args, "--stdin-text", stdin]);
    return { code: r.code, out: r.stdout + r.stderr };
  };

  pi.on("session_start", async (_e, ctx) => {
    settings = readSettings(getAgentDir(), ctx.cwd);
    bundle = new Bundle(Bundle.resolveRoot({ dir: settings.dir }));
    if (!bundle.exists()) { ctx.ui?.notify?.(`memory: no bundle at ${bundle.root}; run memory init`, "warning"); snapshot = ""; snapshotCapturedAt = Date.now(); return; }
    spawnDetached([BIN, "sync", "--dir", bundle.root, "--pull"]);
    refresh(ctx);
  });
  pi.on("before_agent_start", async (event: any, ctx) => {
    // A snapshot captured yesterday (session left open overnight) is stale:
    // refresh before appending so a new day's context isn't served stale.
    if (snapshotIsStale(snapshotCapturedAt, Date.now())) refresh(ctx);
    return snapshot ? { systemPrompt: `${event.systemPrompt}\n\n${snapshot}` } : undefined;
  });
  pi.on("agent_settled", async (_e, ctx) => {
    if (!bundle?.exists() || process.env.MEMORY_FOLD === "off") return;
    const transcript = ctx.sessionManager.getSessionFile(); if (!transcript) return;
    fold(bundle, { session: session(ctx), actor: actor(ctx), transcript, cwd: ctx.cwd, format: "pi", summarizeCmd: summarizeCmd(settings, ctx.model), settings: foldSettings(settings) });
  });
  pi.on("session_before_compact", async (event: any, ctx) => {
    if (!bundle?.exists() || event.customInstructions) return undefined;
    const r = compactionFromSummary(bundle, projectIdFor(ctx.cwd), session(ctx), event.preparation);
    return r ? { compaction: r } : undefined;
  });
  pi.on("session_compact", async (_e, ctx) => refresh(ctx));
  pi.on("session_shutdown", async (_e, ctx) => {
    if (!bundle?.exists() || process.env.MEMORY_FOLD === "off") return;
    const transcript = ctx.sessionManager.getSessionFile(); if (!transcript) return;
    fold(bundle, { session: session(ctx), actor: actor(ctx), transcript, cwd: ctx.cwd, format: "pi", finalize: true, summarizeCmd: summarizeCmd(settings, ctx.model), settings: foldSettings(settings) });
  });

  pi.registerTool({
    name: "memory_remember", label: "Remember",
    description: "Save a durable concept to the shared memory bundle. Types: User (who the user is, bundle root), Feedback (corrections and confirmed approaches), Project (state and decisions not derivable from code), Reference (pointers elsewhere).",
    promptSnippet: "Save a durable fact about the user, project or how to work",
    promptGuidelines: ["Use memory_remember when the user corrects you, states a preference, or decides something the code will not show. Skip anything derivable from the repo."],
    parameters: Type.Object({ type: Type.Union([Type.Literal("User"), Type.Literal("Feedback"), Type.Literal("Project"), Type.Literal("Reference")]), title: Type.String(), description: Type.String(), body: Type.String(), tags: Type.Optional(Type.Array(Type.String())), root: Type.Optional(Type.Boolean()) }),
    async execute(_id, p: any, _signal, _u, ctx) {
      const args = ["remember", "--type", p.type, "--title", p.title, "--description", p.description, "--source", session(ctx)];
      if (p.tags?.length) args.push("--tags", p.tags.join(","));
      if (p.root || p.type === "User") args.push("--root");
      const r = await cli(ctx, args, p.body);
      if (r.code === 0) refresh(ctx);
      return { content: [{ type: "text", text: r.out }] };
    },
  });
  pi.registerTool({
    name: "memory_recall", label: "Recall", description: "Search the memory bundle (bundle root and this project) by terms.",
    promptSnippet: "Search the memory bundle for prior facts, decisions or corrections",
    promptGuidelines: ["Use memory_recall before assuming project history or user preferences that might already be recorded, rather than guessing or re-deriving them from code."],
    parameters: Type.Object({ query: Type.String(), type: Type.Optional(Type.String()) }),
    async execute(_id, p: any, _s, _u, ctx) {
      const hits = recall(bundle, { projectId: projectIdFor(ctx.cwd), query: p.query, type: p.type }).slice(0, 10);
      const text = hits.map((h) => `* [${h.title}](${h.rel}) - ${h.description} (${h.type})`).join("\n") || "no matches";
      return { content: [{ type: "text", text }] };
    },
  });
  pi.registerTool({
    name: "memory_deprecate", label: "Deprecate memory", description: "Retire a concept by slug or path; it leaves the index but stays on disk.",
    promptSnippet: "Retire a memory concept that no longer applies",
    promptGuidelines: ["Use memory_deprecate when a remembered fact is confirmed stale or superseded, instead of leaving it to mislead a later session."],
    parameters: Type.Object({ key: Type.String(), root: Type.Optional(Type.Boolean()) }),
    async execute(_id, p: any, _s, _u, ctx) { const r = await cli(ctx, ["deprecate", p.key, ...(p.root ? ["--root"] : [])]); if (r.code === 0) refresh(ctx); return { content: [{ type: "text", text: r.out }] }; },
  });
  pi.registerTool({
    name: "memory_recall_observation", label: "Recall observation", description: "Expand a [id] observation or reflection line from a session summary into its source transcript entries.",
    promptSnippet: "Expand a session summary's [id] line into its source transcript entries",
    promptGuidelines: ["Use memory_recall_observation when the exact wording or surrounding context behind a summarized [id] line matters, not just the one-line gist."],
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, p: any, _s, _u, ctx) { const r = await cli(ctx, ["recall-observation", p.id]); return { content: [{ type: "text", text: r.out }] }; },
  });
  pi.registerCommand("memory", {
    description: "memory: doctor | recall <query> | sync",
    handler: async (args, ctx) => {
      const [sub, ...rest] = (args ?? "").trim().split(/\s+/);
      const r = sub === "recall" ? await cli(ctx, ["recall", "--md", ...rest]) : sub === "sync" ? await cli(ctx, ["sync"]) : await cli(ctx, ["doctor"]);
      ctx.ui.notify(r.out.trim() || "ok", r.code === 0 ? "info" : "warning");
      if (sub === "sync") refresh(ctx);
    },
  });
}
