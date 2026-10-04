/** The instance card: ports, params, rename, and open-part. */
import type { WorldViewNode } from "@sfab-bench/contract";
import { useEffect, useState } from "react";
import { LevelAxis } from "@/components/LevelAxis";
import { Button } from "@/components/ui/button";
import { openPartFile } from "@/components/WorldPartTabs";
import { forwardLabel, instanceCard } from "@/lib/world-card";
import { openPartTarget } from "@/lib/world-open-part";
import { renamePartOp } from "@/lib/world-ops";
import type { WorldOutline } from "@/lib/world-outline";
import {
  partFileName,
  RENAME_LIBRARY_REASON,
  renamePartTarget,
} from "@/lib/world-rename-part";
import type { PathWarning } from "@/lib/world-warnings";
import { useWorld } from "@/state/world";
import { commitEdit, useWorldEdit } from "@/state/world-edit";
import { LiveBody } from "./live-card";
import { commitOnEnter, commitParam, NumberField } from "./params";
import { Section, WarningList } from "./parts";
import { PoseSection } from "./pose-section";
import { RunCard } from "./run-card";

function ForwardedParam({
  name,
  value,
  from,
}: {
  name: string;
  value: number | string | boolean;
  from: string;
}) {
  return (
    <div className="mb-1.5 min-w-0">
      <div className="text-[11px] text-muted-foreground">{name}</div>
      <div className="break-all font-mono text-[12px]">{String(value)}</div>
      <div className="text-[11px] text-muted-foreground">{from}</div>
    </div>
  );
}

export function RenamePartFile({
  name,
  source,
  rootPart,
  nodePart,
}: {
  name: string;
  source?: WorldViewNode["source"];
  rootPart?: string;
  nodePart?: string;
}) {
  const world = useWorld((s) => s.path);
  const own = !nodePart || nodePart === rootPart;
  const document = own ? world : (nodePart ?? world);
  const part = own ? undefined : nodePart;
  const target = renamePartTarget({ source });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    setOpen(false);
    const op = renamePartOp(document, name, draft);
    if (op) commitEdit([op], { part });
  };
  return (
    <div className="mb-3">
      {open && target.enabled ? (
        <div className="flex flex-col gap-1.5">
          <input
            className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px]"
            aria-label="Part file name"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              commit();
            }}
          />
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={commit}
            >
              Rename
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={!target.enabled}
          title={target.enabled ? "Rename this part file" : target.reason}
          onClick={() => {
            if (!target.enabled) return;
            setDraft(name);
            setOpen(true);
          }}
        >
          Rename part file
        </Button>
      )}
      {!target.enabled ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {target.reason || RENAME_LIBRARY_REASON}
        </p>
      ) : null}
    </div>
  );
}

function OpenPart({ node }: { node: WorldViewNode }) {
  const target = openPartTarget(node);
  return (
    <div className="mb-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={!target.enabled}
        title={target.enabled ? "Open this part" : target.reason}
        onClick={() => {
          if (!target.enabled) return;
          openPartFile(target.file, node.id, node.part);
        }}
      >
        Open part
      </Button>
      {!target.enabled ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {target.reason}
        </p>
      ) : null}
    </div>
  );
}

export function InstanceBody({
  node,
  link,
  outline,
  warnings,
  rootPart,
}: {
  node: WorldViewNode;
  link?: string;
  outline: WorldOutline | null;
  warnings: readonly PathWarning[];
  rootPart?: string;
}) {
  const card = instanceCard(node);
  const stays = useWorldEdit((s) => s.stays);
  return (
    <>
      <RunCard path={node.id} />
      <Section title="Ports">
        {card.ports.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">None</p>
        ) : (
          card.ports.map((port) => (
            <div
              key={port.name}
              className="flex items-baseline gap-2 text-[12px]"
            >
              <span className="font-mono">{port.name}</span>
              {port.fixed ? (
                <span className="text-[11px] text-muted-foreground">fixed</span>
              ) : null}
            </div>
          ))
        )}
      </Section>
      <LiveBody node={node} link={link} outline={outline} />
      <PoseSection node={node} />
      {card.params.length > 0 ? (
        <Section title="Params">
          {card.params.map((param) =>
            param.forward ? (
              <ForwardedParam
                key={param.name}
                name={param.name}
                value={param.value}
                from={forwardLabel(param.forward)}
              />
            ) : typeof param.value === "boolean" ? (
              <label
                key={param.name}
                className="mb-1.5 flex items-center gap-2 text-[12px]"
              >
                <input
                  type="checkbox"
                  checked={param.value}
                  onChange={(event) =>
                    commitParam(
                      node,
                      param.name,
                      event.target.checked ? "true" : "false",
                      param.value
                    )
                  }
                />
                <span className="font-mono">{param.name}</span>
              </label>
            ) : typeof param.value === "number" ? (
              <NumberField
                key={param.name}
                label={param.name}
                value={param.value}
                onCommit={(value) =>
                  commitParam(node, param.name, String(value), param.value)
                }
              />
            ) : (
              <label key={`${param.name}:${stays}`} className="mb-1.5 block">
                <span className="text-[11px] text-muted-foreground">
                  {param.name}
                </span>
                <input
                  className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px]"
                  defaultValue={param.value}
                  onKeyDown={commitOnEnter}
                  onBlur={(event) =>
                    commitParam(
                      node,
                      param.name,
                      event.target.value,
                      param.value
                    )
                  }
                />
              </label>
            )
          )}
        </Section>
      ) : null}
      {card.axes.map((axis) => (
        <Section key={axis.axis} title={axis.axis}>
          <LevelAxis node={node} axis={axis} />
        </Section>
      ))}
      <OpenPart node={node} />
      <RenamePartFile
        name={partFileName(node.part)}
        source={node.source}
        rootPart={rootPart}
        nodePart={node.part}
      />
      <WarningList rows={warnings} />
    </>
  );
}
