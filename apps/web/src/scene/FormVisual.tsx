import type { WorldViewForm } from "@sfab-bench/contract";
import { useEffect, useMemo } from "react";
import type * as THREE from "three";
import { buildVisual, disposeVisual, type Vec3 } from "./visual-forms";

/** One part's drawn visual: its form, or the box in `material`. */
export function FormVisual({
  size,
  form,
  material,
}: {
  size: Vec3;
  form?: WorldViewForm;
  material: THREE.Material;
}) {
  const object = useMemo(
    () => buildVisual(size, form, material),
    [size, form, material]
  );
  useEffect(() => () => disposeVisual(object, material), [object, material]);
  return <primitive object={object} />;
}
