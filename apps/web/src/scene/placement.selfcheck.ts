import * as THREE from "three";

import {
  faceToward,
  forgetCadSpawnKey,
  placeAtGaze,
  shouldPlaceAtGaze,
  spawnDocumentKey,
  XR_CAD_SPAWN_DISTANCE,
  XR_CAD_SPAWN_DROP,
} from "@/scene/SpawnInFront";

/**
 * Tier 5a — where the model lands when a headset spawns it.
 *
 * `placeAtGaze` and `faceToward` are the whole of VR placement, and both are
 * pure functions of a camera pose, so none of this needs a headset. It does need
 * checking somewhere, because the two ways this goes wrong are both invisible on
 * a monitor: a model that drifts closer as the wearer looks down, and a model
 * that inherits the head's roll. The first is merely wrong; the second is the
 * kind of wrong that makes people take the headset off.
 */

const failures: string[] = [];
const note = (why: string) => {
  failures.push(why);
  console.error(`  ✗ ${why}`);
};
const close = (label: string, got: number, want: number, eps = 1e-6) => {
  if (!(Math.abs(got - want) <= eps))
    note(`${label}: ${got.toFixed(6)}, expected ${want}`);
};

/** A head at standing height, yawed `yaw` and pitched `pitch`, both in radians. */
function head(
  yaw: number,
  pitch: number,
  roll = 0,
  at = new THREE.Vector3(0, 1.6, 0)
) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.copy(at);
  camera.rotation.set(pitch, yaw, roll, "YXZ");
  camera.updateMatrixWorld(true);
  return camera;
}

const obj = () => new THREE.Object3D();
const floorGap = (a: THREE.Vector3, b: THREE.Vector3) =>
  Math.hypot(a.x - b.x, a.z - b.z);

// ---------------------------------------------------------------------------

/**
 * The distance is along the floor, not along the gaze. Project the look vector
 * instead of flattening it and a wearer glancing down at their hands pulls the
 * model into their lap; glancing up pushes it through the wall.
 */
for (const pitch of [0, -0.4, 0.4, -1.2, 1.2]) {
  for (const yaw of [0, 0.7, Math.PI, -2.1]) {
    const camera = head(yaw, pitch);
    const o = obj();
    placeAtGaze(o, camera, { distance: 1.2, drop: 0.2 });
    const eye = camera.getWorldPosition(new THREE.Vector3());
    close(
      `floor distance at pitch ${pitch} yaw ${yaw}`,
      floorGap(o.position, eye),
      1.2,
      1e-5
    );
    close(`height at pitch ${pitch} yaw ${yaw}`, o.position.y, 1.6 - 0.2, 1e-6);

    // And it is in front, not behind: the yaw the camera is facing.
    const wanted = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(camera.quaternion)
      .setY(0)
      .normalize();
    const went = o.position.clone().sub(eye).setY(0).normalize();
    close(`bearing at pitch ${pitch} yaw ${yaw}`, went.dot(wanted), 1, 1e-5);
  }
}

/**
 * Straight up and straight down, where the gaze has no floor direction left in it
 * at all. There is no "right answer" to read off the look vector here, so the
 * requirement is continuity: a wearer tipping their head the last degree must not
 * see the model jump across the room behind them. The bearing at vertical has to
 * be the limit the bearing was approaching.
 */
for (const yaw of [0, 0.7, -2.1]) {
  for (const sign of [-1, 1]) {
    const eye = new THREE.Vector3(0, 1.6, 0);
    const bearing = (pitch: number) => {
      const o = obj();
      placeAtGaze(o, head(yaw, pitch), { distance: 1.2 });
      return { o, dir: o.position.clone().sub(eye).setY(0).normalize() };
    };
    const vertical = bearing(sign * (Math.PI / 2));
    // A tenth of a radian off, which is outside the band where the gaze is given up on and
    // is therefore the nearest pose still steered by the look vector itself.
    const almost = bearing(sign * (Math.PI / 2 - 0.1));
    const where = `${sign < 0 ? "down" : "up"} at yaw ${yaw}`;

    if (!vertical.o.position.toArray().every(Number.isFinite)) {
      note(
        `looking straight ${where} placed it at ${vertical.o.position.toArray().join(", ")}`
      );
      continue;
    }
    close(
      `floor distance looking straight ${where}`,
      floorGap(vertical.o.position, eye),
      1.2,
      1e-5
    );
    close(
      `bearing is continuous looking straight ${where}`,
      vertical.dir.dot(almost.dir),
      1,
      1e-6
    );
  }
}

/**
 * `side` steps sideways from that point, square to the line of sight, so two
 * cards can sit either side of the model without one being nearer than the other.
 */
{
  const camera = head(0.9, -0.3);
  const eye = camera.getWorldPosition(new THREE.Vector3());
  const middle = obj();
  placeAtGaze(middle, camera, { distance: 1.2, drop: 0.2 });
  for (const side of [0.5, -0.5]) {
    const o = obj();
    placeAtGaze(o, camera, { distance: 1.2, drop: 0.2, side });
    const step = o.position.clone().sub(middle.position);
    close(`side ${side} distance`, step.length(), Math.abs(side), 1e-5);
    close(`side ${side} stays level`, step.y, 0, 1e-6);
    const right = new THREE.Vector3(1, 0, 0)
      .applyQuaternion(camera.quaternion)
      .setY(0)
      .normalize();
    close(
      `side ${side} direction`,
      step.normalize().dot(right),
      Math.sign(side),
      1e-5
    );
    close(`side ${side} height`, o.position.y, eye.y - 0.2, 1e-6);
  }
}

/**
 * Yaw only. A wearer with their head tilted must not get a tilted model: the
 * horizon of the thing you are looking at is the one fixed reference the inner
 * ear has, and rolling it is what makes VR nauseating rather than merely odd.
 */
{
  for (const [yaw, pitch, roll] of [
    [0, 0, 0],
    [1.3, -0.6, 0.35],
    [-2.4, 0.9, -0.7],
  ] as [number, number, number][]) {
    const camera = head(yaw, pitch, roll);
    const o = obj();
    placeAtGaze(o, camera, { face: true });
    const euler = new THREE.Euler().setFromQuaternion(o.quaternion, "YXZ");
    close(`pitch is not inherited (${yaw},${pitch},${roll})`, euler.x, 0, 1e-6);
    close(`roll is not inherited (${yaw},${pitch},${roll})`, euler.z, 0, 1e-6);

    // Facing means the object's own +Z points back at the wearer.
    const eye = camera.getWorldPosition(new THREE.Vector3());
    const towardEye = eye.clone().sub(o.position).setY(0).normalize();
    const facing = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(o.quaternion)
      .setY(0)
      .normalize();
    close(
      `faces the wearer (${yaw},${pitch},${roll})`,
      facing.dot(towardEye),
      1,
      1e-5
    );
  }
}

/** Without `face`, orientation is left alone — world axes, whatever the head did. */
{
  const o = obj();
  o.quaternion.setFromEuler(new THREE.Euler(0.4, 0.4, 0.4));
  placeAtGaze(o, head(1.1, -0.5, 0.3));
  close(
    "unfaced quaternion is identity",
    o.quaternion.angleTo(new THREE.Quaternion()),
    0,
    1e-6
  );
}

/** Recenter is "put it back at 1:1", so the scale the wearer pinched to is dropped. */
{
  const o = obj();
  o.scale.setScalar(4.5);
  placeAtGaze(o, head(0, 0));
  close("scale reset", o.scale.x, 1, 1e-9);

  const kept = obj();
  kept.scale.setScalar(4.5);
  placeAtGaze(kept, head(0, 0), { resetScale: false });
  close("scale kept when asked", kept.scale.x, 4.5, 1e-9);
}

/**
 * `faceToward` with an explicit point turns a card to the wearer while it hangs
 * off a pivot somewhere else, so the yaw has to come from the point given, not
 * from where the object happens to sit.
 */
{
  const camera = head(0, 0, 0, new THREE.Vector3(3, 1.6, 4));
  const o = obj();
  o.position.set(-5, 0.8, -5);
  const pivot = new THREE.Vector3(0, 0, 0);
  faceToward(o, camera, pivot);
  const facing = new THREE.Vector3(0, 0, 1)
    .applyQuaternion(o.quaternion)
    .setY(0)
    .normalize();
  const towardEye = new THREE.Vector3(3, 0, 4).sub(pivot).setY(0).normalize();
  close(
    "faceToward uses the point it is given",
    facing.dot(towardEye),
    1,
    1e-5
  );
}

/**
 * Product spawn: 0.7 m / 0.12 m drop. Cards sit at 0.55 m; the old CAD
 * spawn was 1.2 m. Algorithm tests above keep 1.2 as an explicit override.
 */
{
  if (!(XR_CAD_SPAWN_DISTANCE > 0.55 && XR_CAD_SPAWN_DISTANCE < 1.2)) {
    note(
      `CAD spawn ${XR_CAD_SPAWN_DISTANCE}m is not between the 0.55m cards and the old 1.2m`
    );
  }
  const camera = head(0, 0);
  const o = obj();
  placeAtGaze(o, camera);
  const eye = camera.getWorldPosition(new THREE.Vector3());
  close(
    "default spawn distance",
    floorGap(o.position, eye),
    XR_CAD_SPAWN_DISTANCE,
    1e-5
  );
  close("default spawn drop", o.position.y, eye.y - XR_CAD_SPAWN_DROP, 1e-6);
}

/**
 * Same-path reload in this XR session must not look like a first spawn.
 * Empty url / no session never places; the caller also forgets `last` then,
 * so close-and-reopen of the same path places again.
 */
{
  const sess = { id: 1 };
  const other = { id: 2 };
  const placed = (got: boolean, want: boolean, label: string) => {
    if (got !== want) note(`${label}: ${got}, expected ${want}`);
  };
  placed(
    shouldPlaceAtGaze({ session: sess, url: "a.step", last: null }),
    true,
    "first spawn"
  );
  placed(
    shouldPlaceAtGaze({
      session: sess,
      url: "a.step",
      last: { session: sess, url: "a.step" },
    }),
    false,
    "same-path reload"
  );
  placed(
    shouldPlaceAtGaze({
      session: sess,
      url: "b.step",
      last: { session: sess, url: "a.step" },
    }),
    true,
    "file switch"
  );
  placed(
    shouldPlaceAtGaze({
      session: other,
      url: "a.step",
      last: { session: sess, url: "a.step" },
    }),
    true,
    "new session same url"
  );
  placed(
    shouldPlaceAtGaze({ session: null, url: "a.step", last: null }),
    false,
    "no session"
  );
  placed(
    shouldPlaceAtGaze({
      session: sess,
      url: "",
      last: { session: sess, url: "a.step" },
    }),
    false,
    "empty url does not place"
  );
  const key = { session: sess, url: "a.step" };
  if (forgetCadSpawnKey(key, sess, "a.step") !== key)
    note("same path keeps last");
  if (forgetCadSpawnKey(key, sess, "") !== null) note("empty url forgets last");
  if (forgetCadSpawnKey(key, null, "a.step") !== null)
    note("no session forgets last");
  placed(
    shouldPlaceAtGaze({
      session: sess,
      url: "a.step",
      last: forgetCadSpawnKey(key, sess, ""),
    }),
    true,
    "reopen after close"
  );
}

/**
 * A world uses the same spawn key as a STEP. Switching STEP → world → STEP
 * in one session places each time. Reloading the same world does not.
 */
{
  if (spawnDocumentKey("", "cad/a.step") !== "cad/a.step") {
    note("a STEP path is the spawn document");
  }
  if (
    spawnDocumentKey("examples/arm/parts/sfab/arm-bench@1.0.0.json", "") !==
    "examples/arm/parts/sfab/arm-bench@1.0.0.json"
  ) {
    note("a world path is the spawn document");
  }
  if (
    spawnDocumentKey(
      "examples/arm/parts/sfab/arm-bench@1.0.0.json",
      "cad/a.step"
    ) !== "examples/arm/parts/sfab/arm-bench@1.0.0.json"
  ) {
    note("a world wins when both paths are set");
  }
  if (spawnDocumentKey("", "") !== "") note("nothing open does not spawn");

  const placed = (got: boolean, want: boolean, label: string) => {
    if (got !== want) note(`${label}: ${got}, expected ${want}`);
  };
  const sess = { id: 1 };
  let last: { session: unknown; url: string } | null = null;
  const stepA = spawnDocumentKey("", "cad/a.step");
  placed(
    shouldPlaceAtGaze({ session: sess, url: stepA, last }),
    true,
    "STEP spawns"
  );
  last = { session: sess, url: stepA };
  const world = spawnDocumentKey(
    "examples/arm/parts/sfab/arm-bench@1.0.0.json",
    ""
  );
  placed(
    shouldPlaceAtGaze({ session: sess, url: world, last }),
    true,
    "STEP to world places again"
  );
  last = { session: sess, url: world };
  // A forced reopen bumps loadId and a disk reload bumps revision.
  // Neither belongs in spawnDocumentKey: this stays false, and a
  // grabbed world does not snap back in front.
  placed(
    shouldPlaceAtGaze({ session: sess, url: world, last }),
    false,
    "the same world does not respawn"
  );
  const other = spawnDocumentKey("examples/arm/other.world.json", "");
  placed(
    shouldPlaceAtGaze({ session: sess, url: other, last }),
    true,
    "a second world places"
  );
  last = { session: sess, url: other };
  const stepB = spawnDocumentKey("", "cad/b.step");
  placed(
    shouldPlaceAtGaze({ session: sess, url: stepB, last }),
    true,
    "world to STEP places again"
  );
}

if (failures.length) throw new Error(`${failures.length} placement failure(s)`);
console.log("placement.selfcheck ok");
