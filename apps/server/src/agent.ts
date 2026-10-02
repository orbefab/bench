import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createCodex } from "@ai-sdk/harness-codex";
import { createCursor } from "@ai-sdk/harness-cursor";
import { createGrokBuild } from "@ai-sdk/harness-grok-build";
import { createOpenCode } from "@ai-sdk/harness-opencode";
import {
  type ChatEffort,
  DEFAULT_HARNESS_MODEL,
  type HarnessId,
} from "@sfab-bench/contract";
import { z } from "zod";
import { AGENT_IDENTITY } from "./agent-identity";
import { boardTools } from "./board-tools";
import { createLocalSandbox } from "./local-sandbox";
import { viewerTools } from "./viewer-context";
import { worldTools } from "./world-tools";

const callOptions = z.object({ model: z.string().min(1) });

type ReasoningLevel = Exclude<ChatEffort, "default">;

function reasoning(effort: ChatEffort): ReasoningLevel | undefined {
  return effort === "default" ? undefined : effort;
}

/** The adapter alone, so provisioning can run a bootstrap without an agent. */
export function harnessAdapter(id: HarnessId, effort: ChatEffort = "default") {
  const level = reasoning(effort);
  if (id === "codex") {
    return createCodex({
      // Direct = Mac login / provider env. Not AI Gateway (that key is STT-only).
      auth: "direct",
      ...(level ? { reasoningEffort: level } : {}),
    });
  }
  if (id === "cursor") return createCursor({ auth: "direct" });
  if (id === "grok-build") {
    return createGrokBuild({
      auth: "direct",
      ...(level ? { reasoningEffort: level } : {}),
    });
  }
  return createOpenCode({
    // OpenCode has no `direct`. Isolated env so STT's Gateway key is not inherited.
    auth: {},
    provider: "zai-coding-plan",
    ...(level ? { reasoningVariant: level } : {}),
  });
}

function makeAgent(id: HarnessId, effort: ChatEffort, root: string) {
  const shared = {
    sandbox: createLocalSandbox(root),
    tools: { ...viewerTools, ...boardTools, ...worldTools },
    instructions: AGENT_IDENTITY,
    permissionMode: "allow-all" as const,
    callOptionsSchema: callOptions,
    prepareCall: ({ options, ...rest }: { options: { model: string } }) => ({
      ...rest,
      model: options.model,
    }),
  };
  const harness = harnessAdapter(id, effort);

  if (id === "codex") {
    return new HarnessAgent({
      id: `sfab-codex-${effort}`,
      harness,
      model: DEFAULT_HARNESS_MODEL.codex,
      ...shared,
    });
  }
  if (id === "cursor") {
    return new HarnessAgent({
      id: "sfab-cursor",
      harness,
      model: DEFAULT_HARNESS_MODEL.cursor,
      ...shared,
    });
  }
  if (id === "grok-build") {
    return new HarnessAgent({
      id: `sfab-grok-build-${effort}`,
      harness,
      model: DEFAULT_HARNESS_MODEL["grok-build"],
      ...shared,
    });
  }
  return new HarnessAgent({
    id: `sfab-opencode-${effort}`,
    harness,
    model: process.env.OPENCODE_MODEL ?? DEFAULT_HARNESS_MODEL.opencode,
    ...shared,
  });
}

type AnyAgent = ReturnType<typeof makeAgent>;

const agents = new Map<string, AnyAgent>();

function agentKey(id: HarnessId, effort: ChatEffort, root: string) {
  return id === "cursor" ? `${root}:${id}` : `${root}:${id}:${effort}`;
}

export function getAgent(id: HarnessId, effort: ChatEffort, root: string) {
  const key = agentKey(id, effort, root);
  let agent = agents.get(key);
  if (!agent) {
    agent = makeAgent(id, effort, root);
    agents.set(key, agent);
  }
  return agent;
}
