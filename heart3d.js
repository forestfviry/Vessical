/* =========================================================================
 * Vessical — interactive 3D heart (Three.js)
 *
 * Self-contained module. It does NOT touch app.js internals:
 *   app.js  -> Heart3D.update(vessels)   risk colours + lumen narrowing
 *   app.js  -> Heart3D.setActive(v)      highlight selected artery
 *   heart3d -> document event "heart3d:select" (detail = "LAD"|"LCX"|"RCA")
 *
 * If WebGL or the CDN import fails, the original SVG schematic stays visible.
 * ========================================================================= */
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

const VESSELS = ["LAD", "LCX", "RCA"];
const IDLE = 0x64748b;
const TUBE_R = 0.045;
const STENOSIS_AT = 0.55;            // where along the artery the narrowing is drawn
const ZS = 0.72;                     // front-to-back flattening of the ventricles
const box = document.querySelector(".heart-schematic");

const probColor = (p) => (p < 0.35 ? 0x10b981 : p < 0.65 ? 0xf59e0b : 0xef4444);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

function webglOk() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch (_) { return false; }
}

if (box && webglOk()) {
  try { init(); } catch (e) { console.warn("[heart3d] falling back to SVG:", e); }
}

function init() {
  /* ---------- scene ---------- */
  const host = document.createElement("div");
  host.id = "heart3d";
  box.prepend(host);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
  camera.position.set(0, 0.1, 6.4);

  scene.add(new THREE.HemisphereLight(0xffe4ec, 0x1a0f18, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 1.7); key.position.set(-3, 4, 5);
  const rim = new THREE.DirectionalLight(0xff9ab8, 0.9); rim.position.set(4, -1, -3);
  scene.add(key, rim);

  const pivot = new THREE.Group();            // user rotation (yaw / pitch)
  pivot.rotation.order = "YXZ";
  const root = new THREE.Group();             // anatomical tilt: apex points to viewer's right
  root.rotation.z = 0.38;
  const beat = new THREE.Group();             // heartbeat scale
  scene.add(pivot); pivot.add(root); root.add(beat);

  /* ---------- heart surface (surface of revolution of the classic heart curve) ---------- */
  const K = 0.1;
  const prof = (t) => ({
    r: 16 * Math.sin(t) ** 3 * K,
    y: (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t) + 2.5) * K,
  });
  // point on the surface; t: 0 (top cleft) -> PI (apex), v: angle around the axis (PI/2 = front)
  const pt = (t, v, lift = 1) => {
    const p = prof(t);
    return new THREE.Vector3(p.r * Math.cos(v) * lift, p.y, p.r * Math.sin(v) * ZS * lift);
  };

  const pts = [];
  for (let i = 0; i <= 90; i++) { const p = prof(Math.PI * (1 - i / 90)); pts.push(new THREE.Vector2(Math.max(p.r, 0.0001), p.y)); }
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: 0x9a4a5f, roughness: 0.55, metalness: 0.04, clearcoat: 0.35, clearcoatRoughness: 0.5,
    side: THREE.DoubleSide,
  });
  const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 96), bodyMat);
  body.scale.z = ZS;
  beat.add(body);

  // atria
  const atriaMat = new THREE.MeshStandardMaterial({ color: 0x7d3a50, roughness: 0.6 });
  const ra = new THREE.Mesh(new THREE.SphereGeometry(0.55, 32, 24), atriaMat);
  ra.position.set(-1.05, 1.0, -0.15); ra.scale.set(1, 0.85, 0.8);
  const la = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 24), atriaMat);
  la.position.set(1.0, 1.05, -0.2); la.scale.set(1, 0.8, 0.8);
  beat.add(ra, la);

  // great vessels
  const vesselWall = new THREE.MeshStandardMaterial({ color: 0xc46a7e, roughness: 0.5 });
  const tube = (arr, r) => new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(arr.map((a) => new THREE.Vector3(...a))), 40, r, 16, false), vesselWall);
  beat.add(
    tube([[0.15, 0.9, 0], [0.2, 1.6, 0.0], [0.55, 2.05, -0.1], [0.95, 1.7, -0.15]], 0.21),   // aorta + arch
    tube([[-0.2, 0.95, 0.3], [-0.25, 1.55, 0.35], [-0.7, 1.9, 0.15]], 0.16),                  // pulmonary trunk
  );

  /* ---------- coronary arteries ---------- */
  const path = (t0, t1, v0, v1, lift, n = 9) =>
    new THREE.CatmullRomCurve3(Array.from({ length: n }, (_, i) => {
      const f = i / (n - 1);
      return pt(t0 + (t1 - t0) * f, v0 + (v1 - v0) * f, lift);
    }));

  // Anterior view: patient's right (RCA) is on the viewer's left
  const CURVES = {
    LAD: path(0.95, 2.95, 1.38, 1.5, 1.025),   // anterior interventricular groove, down to the apex
    LCX: path(1.05, 1.55, 1.25, -0.95, 1.025), // AV groove, wraps to the back on the viewer's right
    RCA: path(1.3, 1.6, 1.95, 3.75, 1.025),    // AV groove, wraps to the back on the viewer's left
  };

  function lumenTube(curve, p) {                // tube whose radius pinches around STENOSIS_AT by p
    const seg = 64, rad = 12;
    const g = new THREE.TubeGeometry(curve, seg, TUBE_R, rad, false);
    const pos = g.attributes.position, c = new THREE.Vector3(), v = new THREE.Vector3();
    for (let i = 0; i <= seg; i++) {
      curve.getPointAt(i / seg, c);
      const f = 1 - 0.6 * p * Math.exp(-(((i / seg - STENOSIS_AT) / 0.1) ** 2));
      for (let j = 0; j <= rad; j++) {
        const k = i * (rad + 1) + j;
        v.fromBufferAttribute(pos, k).sub(c).multiplyScalar(f).add(c);
        pos.setXYZ(k, v.x, v.y, v.z);
      }
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  }

  const art = {};
  const labels = {};
  const hitMeshes = [];
  VESSELS.forEach((name) => {
    const curve = CURVES[name];
    const mat = new THREE.MeshStandardMaterial({ color: IDLE, emissive: IDLE, emissiveIntensity: 0.25, roughness: 0.35 });
    const mesh = new THREE.Mesh(lumenTube(curve, 0), mat);
    const haloMat = new THREE.MeshBasicMaterial({ color: IDLE, transparent: true, opacity: 0, depthWrite: false });
    const halo = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, TUBE_R * 2.4, 10, false), haloMat);   // also the click target
    halo.userData.vessel = name;
    beat.add(mesh, halo);
    hitMeshes.push(halo);

    const anchor = new THREE.Object3D();
    anchor.position.copy(curve.getPointAt(name === "LAD" ? 0.9 : 0.97)).multiplyScalar(1.12);
    root.add(anchor);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "h3d-label";
    btn.textContent = name;
    btn.setAttribute("aria-label", `Inspect ${name}`);
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", () => select(name));
    host.appendChild(btn);

    art[name] = { curve, mat, mesh, halo, haloMat, anchor, p: undefined };
    labels[name] = btn;
  });

  /* ---------- public API (called from app.js) ---------- */
  let active = "LAD";

  function update(vessels = {}) {
    VESSELS.forEach((name) => {
      const a = art[name];
      const p = (vessels[name] || {}).stenosis_probability;
      const col = p === undefined ? IDLE : probColor(p);
      a.mat.color.setHex(col); a.mat.emissive.setHex(col);
      a.mat.emissiveIntensity = p === undefined ? 0.25 : 0.35 + 0.5 * p;
      a.haloMat.color.setHex(col);
      if (a.p !== p) {
        a.mesh.geometry.dispose();
        a.mesh.geometry = lumenTube(a.curve, p || 0);
        a.p = p;
      }
      labels[name].title = p === undefined ? name : `${name} · ${(p * 100).toFixed(1)}%`;
    });
  }

  function setActive(v) {
    active = v;
    VESSELS.forEach((name) => {
      art[name].haloMat.opacity = name === v ? 0.32 : 0;
      labels[name].classList.toggle("active", name === v);
    });
  }

  function select(v) { document.dispatchEvent(new CustomEvent("heart3d:select", { detail: v })); }

  window.Heart3D = { update, setActive };

  /* ---------- interaction: drag to rotate, click to pick, double-click to reset ---------- */
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const HOME = { yaw: 0.3, pitch: -0.08 };
  let yaw = HOME.yaw, pitch = HOME.pitch, touched = false, drag = null;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();

  const pick = (e) => {
    const r = host.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(hitMeshes, false)[0];
    return hit ? hit.object.userData.vessel : null;
  };

  host.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: 0 };
    host.setPointerCapture(e.pointerId);
    host.classList.add("grabbing");
  });
  host.addEventListener("pointermove", (e) => {
    if (!drag) { host.style.cursor = pick(e) ? "pointer" : ""; return; }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
    yaw += dx * 0.009; pitch = clamp(pitch + dy * 0.006, -0.9, 0.9);
    touched = true;
  });
  const end = (e) => {
    if (drag && drag.moved < 5 && e.type === "pointerup") { const v = pick(e); if (v) select(v); }
    drag = null; host.classList.remove("grabbing");
  };
  host.addEventListener("pointerup", end);
  host.addEventListener("pointercancel", end);
  host.addEventListener("dblclick", () => { yaw = HOME.yaw; pitch = HOME.pitch; touched = false; });

  /* ---------- sizing + render loop ---------- */
  const size = () => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  new ResizeObserver(size).observe(host);
  size();

  let onScreen = true;
  new IntersectionObserver((en) => { onScreen = en[0].isIntersecting; }).observe(host);

  const tmp = new THREE.Vector3();
  function frame(ms) {
    requestAnimationFrame(frame);
    if (!onScreen) return;

    if (!touched && !reduce) yaw = HOME.yaw + Math.sin(ms / 2600) * 0.28;   // gentle idle sway
    pivot.rotation.set(pitch, yaw, 0);

    if (!reduce) {                                                          // lub-dub
      const ph = (ms % 1100) / 1100;
      beat.scale.setScalar(1 + 0.03 * Math.exp(-(((ph - 0.1) / 0.05) ** 2)) + 0.018 * Math.exp(-(((ph - 0.3) / 0.06) ** 2)));
    }

    const w = host.clientWidth, h = host.clientHeight;
    VESSELS.forEach((name) => {
      art[name].anchor.getWorldPosition(tmp);
      const facing = tmp.z > -0.15;
      tmp.project(camera);
      const el = labels[name];
      el.style.transform = `translate(${((tmp.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-tmp.y * 0.5 + 0.5) * h).toFixed(1)}px) translate(-50%, -50%)`;
      el.style.opacity = facing ? "1" : "0.35";
    });

    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  update({});
  setActive(active);
  box.classList.add("has-3d");
}
