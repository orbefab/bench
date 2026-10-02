/** Param and play fields, and the edits they commit. */
import {
  DEFAULT_TIMESTEP_S,
  type WorldViewNode,
  type WorldViewPlay,
} from "@sfab-bench/contract";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useState,
} from "react";
import { instanceEditTarget } from "@/lib/world-edit-target";
import { type PlayChange, setParamOp, setPlayOp } from "@/lib/world-ops";
import { worldStore } from "@/state/world";
import { commitEdit, useWorldEdit } from "@/state/world-edit";
import { Section } from "./parts";

export function commitParam(
  node: WorldViewNode,
  name: string,
  raw: string,
  previous: number | string | boolean
) {
  const tree = worldStore.getState().tree;
  if (!tree) return;
  const target = instanceEditTarget(tree, node.id, worldStore.getState().path);
  if (!target) return;
  const op = setParamOp(target, name, raw, previous);
  if (op) commitEdit([op], { part: target.part });
}

function commitPlay(current: WorldViewPlay, next: PlayChange) {
  const op = setPlayOp(worldStore.getState().path, current, next);
  if (op) commitEdit([op]);
}

/**
 * Enter commits by leaving the field. Mark the key handled first: an
 * unhandled Enter that lands on the body after the blur is sent back
 * by Chrome on macOS, and in an unfocused window it repeats forever.
 */
export function commitOnEnter(event: ReactKeyboardEvent<HTMLInputElement>) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  event.currentTarget.blur();
}

export function NumberField({
  label,
  value,
  onCommit,
  disabled,
  title,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  disabled?: boolean;
  title?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const stays = useWorldEdit((s) => s.stays);
  // Stay on the ask drops the typed value, even when the card's did not move.
  useEffect(() => setDraft(String(value)), [value, stays]);
  return (
    <label className="mb-1.5 block min-w-0" title={title}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input
        className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px] disabled:opacity-50"
        disabled={disabled}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = Number(draft);
          if (!Number.isFinite(next)) {
            setDraft(String(value));
            return;
          }
          onCommit(next);
        }}
        onKeyDown={commitOnEnter}
      />
    </label>
  );
}

export function PlayFields({ play }: { play: WorldViewPlay }) {
  return (
    <Section title="Play">
      <NumberField
        label="Gravity x"
        value={play.gravity[0]}
        onCommit={(value) =>
          commitPlay(play, {
            gravity: [value, play.gravity[1], play.gravity[2]],
          })
        }
      />
      <NumberField
        label="Gravity y"
        value={play.gravity[1]}
        onCommit={(value) =>
          commitPlay(play, {
            gravity: [play.gravity[0], value, play.gravity[2]],
          })
        }
      />
      <NumberField
        label="Gravity z"
        value={play.gravity[2]}
        onCommit={(value) =>
          commitPlay(play, {
            gravity: [play.gravity[0], play.gravity[1], value],
          })
        }
      />
      <NumberField
        label="Seed"
        value={play.seed}
        onCommit={(value) => commitPlay(play, { seed: value })}
      />
      <NumberField
        label="Time step"
        value={play.timestep ?? DEFAULT_TIMESTEP_S}
        onCommit={(value) => commitPlay(play, { timestep: value })}
      />
    </Section>
  );
}
