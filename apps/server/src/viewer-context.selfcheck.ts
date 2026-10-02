import { ok as expect } from "node:assert/strict";
import { AGENT_IDENTITY } from "./agent-identity";
import { viewerTools } from "./viewer-context";

expect(
  typeof viewerTools.get_viewer.execute !== "function",
  "get_viewer has no server execute"
);
expect(
  typeof viewerTools.show_artifact.execute === "function",
  "show_artifact stays on the server"
);

expect(AGENT_IDENTITY.includes("drop a STEP"), "identity: drop STEP");
expect(
  !/cad skill|earthtojake/i.test(AGENT_IDENTITY),
  "identity does not name the CAD skill"
);
expect(
  AGENT_IDENTITY.includes("Do not git clone into this folder."),
  "identity forbids clone into cwd"
);

console.log("viewer-context.selfcheck ok");
