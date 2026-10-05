/**
 * Programs and value sets on the instance card (run 7 unit 5a-1). Each
 * gesture commits the whole value as one `set-param`, so one undo step.
 */
import {
  type Program,
  programDuration,
  SEGMENT_FIELDS,
  SEGMENT_KINDS,
  type Segment,
  type SegmentKind,
  SI_UNIT,
  type StructuredDecl,
  type StructuredValue,
  type ValueSet,
  type WorldViewNode,
} from "@sfab-bench/contract";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  addSegment,
  addValue,
  addVariant,
  moveSegment,
  newProgram,
  newValueSet,
  previewOf,
  removeSegment,
  removeValue,
  removeVariant,
  renameVariant,
  selectValue,
  selectVariant,
  setSegmentField,
  setSegmentKind,
  setValue,
} from "@/lib/program-edit";
import { type CardStructured, forwardLabel } from "@/lib/world-card";
import { instanceEditTarget } from "@/lib/world-edit-target";
import { setStructuredOp } from "@/lib/world-ops";
import { worldStore } from "@/state/world";
import { commitEdit } from "@/state/world-edit";
import { commitOnEnter, NumberField } from "./params";

function commitStructured(
  node: WorldViewNode,
  name: string,
  next: StructuredValue | null,
  previous: StructuredValue | null
) {
  const tree = worldStore.getState().tree;
  if (!tree) return;
  const target = instanceEditTarget(tree, node.id, worldStore.getState().path);
  if (!target) return;
  const op = setStructuredOp(target, name, next, previous);
  if (op) commitEdit([op], { part: target.part });
}

const KIND_LABEL: Record<SegmentKind, string> = {
  hold: "Hold",
  step: "Step",
  ramp: "Ramp",
  chirp: "Chirp",
  prbs: "PRBS",
};

/** A field's label with its unit: levels in the declared quantity. */
function fieldLabel(field: string, unit: string): string {
  switch (field) {
    case "dur":
    case "period":
      return `${field} (s)`;
    case "f0":
    case "f1":
      return `${field} (Hz)`;
    case "phase":
      return "phase (rad)";
    case "seed":
      return "seed";
    default:
      return unit ? `${field} (${unit})` : field;
  }
}

function unitOf(decl: StructuredDecl | null): string {
  return decl ? SI_UNIT[decl.quantity] : "";
}

function summary(value: StructuredValue, unit: string): string {
  if (value.kind === "values") {
    return `${value.values.length} values, runs ${value.values[value.use]} ${unit}`.trim();
  }
  const total = programDuration(value);
  return `${value.variants.length} variant${value.variants.length === 1 ? "" : "s"}, runs ${value.use} (${total} s)`;
}

export function StructuredParams({
  node,
  rows,
}: {
  node: WorldViewNode;
  rows: readonly CardStructured[];
}) {
  return rows.map((row) => {
    const unit = unitOf(row.decl);
    if (row.forward) {
      return (
        <div key={row.name} className="mb-2 min-w-0">
          <div className="text-[11px] text-muted-foreground">{row.name}</div>
          <div className="text-[12px]">
            {row.value ? summary(row.value, unit) : "not set"}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {forwardLabel(row.forward)}
          </div>
        </div>
      );
    }
    if (!row.value) {
      const kind = row.decl?.kind ?? "program";
      return (
        <div key={row.name} className="mb-2 flex items-center gap-2">
          <span className="font-mono text-[12px]">{row.name}</span>
          <span className="text-[11px] text-muted-foreground">not set</span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-6 px-2"
            onClick={() =>
              commitStructured(
                node,
                row.name,
                kind === "values" ? newValueSet() : newProgram(),
                null
              )
            }
          >
            {kind === "values" ? "Set values" : "Set program"}
          </Button>
        </div>
      );
    }
    // A gesture that changes nothing or would not parse returns null:
    // nothing is sent, and a field shows the stored value again.
    const commit = (next: StructuredValue | null) => {
      commitStructured(node, row.name, next, row.value);
      return next !== null;
    };
    return row.value.kind === "program" ? (
      <ProgramEditor
        key={row.name}
        name={row.name}
        program={row.value}
        unit={unit}
        commit={commit}
      />
    ) : (
      <ValueSetEditor
        key={row.name}
        name={row.name}
        set={row.value}
        unit={unit}
        commit={commit}
      />
    );
  });
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function ProgramEditor({
  name,
  program,
  unit,
  commit,
}: {
  name: string;
  program: Program;
  unit: string;
  commit: (next: Program | null) => boolean;
}) {
  const id = program.use;
  const segments =
    program.variants.find((row) => row.id === id)?.segments ?? [];
  return (
    <div className="mb-3 min-w-0">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="font-mono text-[12px]">{name}</span>
        <span className="text-[11px] text-muted-foreground">
          program{unit ? ` (${unit})` : ""}, {programDuration(program)} s
        </span>
      </div>
      <div className="mb-1 flex items-center gap-1">
        <Select
          modal={false}
          value={id}
          items={program.variants.map((row) => ({
            value: row.id,
            label: row.id,
          }))}
          onValueChange={(value: string | null) => {
            if (value) commit(selectVariant(program, value));
          }}
        >
          <SelectTrigger
            aria-label={`${name} variant`}
            title="The variant Play runs"
            className="border border-border"
          >
            <span className="text-muted-foreground">variant</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {program.variants.map((row) => (
              <SelectItem key={row.id} value={row.id}>
                {row.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <VariantName
          id={id}
          onRename={(to) => commit(renameVariant(program, id, to))}
        />
        <IconButton
          label="Add a variant (a copy of this one)"
          onClick={() => commit(addVariant(program))}
        >
          <Plus />
        </IconButton>
        <IconButton
          label="Remove this variant"
          disabled={program.variants.length < 2}
          onClick={() => commit(removeVariant(program, id))}
        >
          <X />
        </IconButton>
      </div>
      <ProgramPreview program={program} unit={unit} />
      {segments.map((segment, at) => (
        <SegmentRow
          // Segments have no identity of their own; a moved row remounts.
          key={`${id}:${at}:${segment.kind}`}
          segment={segment}
          at={at}
          last={at === segments.length - 1}
          unit={unit}
          program={program}
          commit={commit}
        />
      ))}
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2"
        onClick={() => commit(addSegment(program, id, segments.length - 1))}
      >
        <Plus /> Segment
      </Button>
    </div>
  );
}

function VariantName({
  id,
  onRename,
}: {
  id: string;
  onRename: (to: string) => void;
}) {
  const [draft, setDraft] = useState(id);
  useEffect(() => setDraft(id), [id]);
  return (
    <input
      aria-label="Variant name"
      className="h-7 w-16 min-w-0 rounded-md border border-border bg-background px-1.5 font-mono text-[12px]"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={commitOnEnter}
      onBlur={() => {
        if (draft.trim() && draft.trim() !== id) onRename(draft);
        else setDraft(id);
      }}
    />
  );
}

function SegmentRow({
  segment,
  at,
  last,
  unit,
  program,
  commit,
}: {
  segment: Segment;
  at: number;
  last: boolean;
  unit: string;
  program: Program;
  commit: (next: Program | null) => boolean;
}) {
  const id = program.use;
  const fields = ["dur", ...SEGMENT_FIELDS[segment.kind]];
  const values = segment as unknown as Record<string, number>;
  return (
    <div className="mb-1.5 rounded-md border border-border px-1.5 pt-1">
      <div className="flex items-center gap-1">
        <span className="w-4 text-[11px] text-muted-foreground">{at + 1}</span>
        <Select
          modal={false}
          value={segment.kind}
          items={SEGMENT_KINDS.map((kind) => ({
            value: kind,
            label: KIND_LABEL[kind],
          }))}
          onValueChange={(value: string | null) => {
            if (value)
              commit(setSegmentKind(program, id, at, value as SegmentKind));
          }}
        >
          <SelectTrigger aria-label={`Segment ${at + 1} kind`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEGMENT_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto" />
        <IconButton
          label="Move up"
          disabled={at === 0}
          onClick={() => commit(moveSegment(program, id, at, -1))}
        >
          <ArrowUp />
        </IconButton>
        <IconButton
          label="Move down"
          disabled={last}
          onClick={() => commit(moveSegment(program, id, at, 1))}
        >
          <ArrowDown />
        </IconButton>
        <IconButton
          label="Remove segment"
          disabled={at === 0 && last}
          onClick={() => commit(removeSegment(program, id, at))}
        >
          <X />
        </IconButton>
      </div>
      <div className="grid grid-cols-2 gap-x-2">
        {fields.map((field) => (
          <NumberField
            key={field}
            label={fieldLabel(field, unit)}
            value={values[field] ?? 0}
            onCommit={(value) =>
              commit(setSegmentField(program, id, at, field, value))
            }
          />
        ))}
      </div>
    </div>
  );
}

const PREVIEW_W = 240;
const PREVIEW_H = 44;

function ProgramPreview({ program, unit }: { program: Program; unit: string }) {
  const { total, samples, min, max } = previewOf(program);
  const span = max - min;
  // A constant program draws mid-height, not on the bottom edge.
  const y = (v: number) =>
    span > 0
      ? PREVIEW_H - 2 - ((v - min) / span) * (PREVIEW_H - 4)
      : PREVIEW_H / 2;
  const points = samples
    .map(
      (row) =>
        `${((row.t / total) * PREVIEW_W).toFixed(1)},${y(row.v).toFixed(1)}`
    )
    .join(" ");
  return (
    <figure className="mb-1.5">
      <svg
        viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}
        className="h-11 w-full rounded-md border border-border bg-muted/30"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${program.use} from ${min} to ${max} ${unit} over ${total} s`}
      >
        <polyline
          points={points}
          fill="none"
          className="stroke-primary"
          strokeWidth={1.2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="flex justify-between text-[10px] text-muted-foreground">
        <span>
          {min === max ? `${min}` : `${min} to ${max}`} {unit}
        </span>
        <span>0 to {total} s</span>
      </figcaption>
    </figure>
  );
}

function ValueSetEditor({
  name,
  set,
  unit,
  commit,
}: {
  name: string;
  set: ValueSet;
  unit: string;
  commit: (next: ValueSet | null) => boolean;
}) {
  return (
    <div className="mb-3 min-w-0">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="font-mono text-[12px]">{name}</span>
        <span className="text-[11px] text-muted-foreground">
          values{unit ? ` (${unit})` : ""}, a capture runs each
        </span>
      </div>
      {set.values.map((value, at) => (
        <div key={at} className="flex items-end gap-1">
          <input
            type="radio"
            className="mb-3"
            aria-label={`Play runs value ${at + 1}`}
            title="The value Play runs"
            checked={set.use === at}
            onChange={() => commit(selectValue(set, at))}
          />
          <div className="min-w-0 flex-1">
            <NumberField
              label={`${at + 1}${unit ? ` (${unit})` : ""}`}
              value={value}
              onCommit={(next) => commit(setValue(set, at, next))}
            />
          </div>
          <div className="mb-2">
            <IconButton
              label="Remove value"
              disabled={set.values.length < 2}
              onClick={() => commit(removeValue(set, at))}
            >
              <X />
            </IconButton>
          </div>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2"
        onClick={() => commit(addValue(set))}
      >
        <Plus /> Value
      </Button>
    </div>
  );
}
