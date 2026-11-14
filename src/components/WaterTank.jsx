import {
	useRef,
	useMemo,
	useCallback,
	useImperativeHandle,
	useLayoutEffect,
} from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { createTimeline, stagger } from "animejs";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import * as THREE from "three";
import Splashes from "./Splashes";
import { createWaterMaterials } from "./waterShader";
import {
	N,
	SIZE,
	DX,
	DAM_X,
	BUILDINGS,
	bedHeight,
	cellPos,
	createSolver,
} from "../physics/sweSolver";

/* ---------- Layout constants (world units) ---------- */
const WALL_H = 1.1; // intact dam height
const RUBBLE = 0.15; // ground height of the collapsed dam (matches solver)
const RIM_H = 0.9; // height of the tank rim
const RIM_T = 0.24; // retaining wall thickness
const TOE = 0.425; // dam pivot (downstream toe) offset from DAM_X
const CHUNK_W = 1.2; // the dam is 5 segments, each 1.2 wide (fixed abutments close the rest)
const CHUNKS = [-2.4, -1.2, 0, 1.2, 2.4]; // chunk centres along Z (the middle one is the sluice gate)
const ring = (zc) => Math.round(Math.abs(zc) / CHUNK_W); // 0 = centre, 1, 2 = outer

// Pastel pine trees (x, z, scale) and streetlamps (x, z) around the town
const TREES = [
	{ x: 3.4, z: -2.2, s: 1.1 },
	{ x: 2.6, z: -3.0, s: 0.9 },
	{ x: 3.5, z: -0.9, s: 0.85 },
	{ x: 2.3, z: 3.0, s: 1 },
	{ x: 3.5, z: 3.0, s: 1.15 },
	{ x: 0.8, z: -3.0, s: 0.9 },
	{ x: 0.6, z: 2.8, s: 0.8 },
	{ x: 3.3, z: 0.6, s: 0.8 },
];
const LAMPS = [
	{ x: 0.7, z: -1.0 },
	{ x: 1.0, z: 0.9 },
	{ x: 2.0, z: -1.2 },
	{ x: 2.1, z: 1.0 },
	{ x: 0.9, z: 2.3 },
];

/* ---------- Cel-shading for solid objects: 3-step gradient ---------- */
const toonGradient = (() => {
	const tex = new THREE.DataTexture(
		new Uint8Array([120, 190, 255]),
		3,
		1,
		THREE.RedFormat,
	);
	tex.minFilter = tex.magFilter = THREE.NearestFilter; // no blending => hard bands
	tex.needsUpdate = true;
	return tex;
})();

// matRef lets us reach a material later (used for the impact flash)
const Toon = ({ matRef, ...props }) => (
	<meshToonMaterial
		ref={matRef}
		gradientMap={toonGradient}
		polygonOffset
		polygonOffsetFactor={1}
		polygonOffsetUnits={1}
		{...props}
	/>
);
/* ---------- Bold ink outlines ----------
   Fat, anti-aliased lines drawn on every sharp edge of a mesh (three's LineSegments2).
   Their width is in SCREEN pixels, so they stay bold and even at every zoom level. */
const INK_PX = 3.5; // big objects (CSS pixels)
const THIN_PX = 2; // small props
const inkMat = new LineMaterial({ color: 0x191a19, linewidth: INK_PX });
const inkThin = new LineMaterial({ color: 0x191a19, linewidth: THIN_PX });
const pxSize = new THREE.Vector2();

// Put <Ink /> inside any <mesh>: it reads that mesh's geometry and adds the outline as a child.
function Ink({ thin = false, angle = 20 }) {
	const holder = useRef();
	useLayoutEffect(() => {
		const group = holder.current;
		const edges = new THREE.EdgesGeometry(group.parent.geometry, angle); // edges sharper than `angle` degrees
		const geo = new LineSegmentsGeometry().fromEdgesGeometry(edges);
		const lines = new LineSegments2(geo, thin ? inkThin : inkMat);
		lines.raycast = () => {}; // outlines never block clicks
		lines.frustumCulled = false;
		group.add(lines);
		return () => {
			group.remove(lines);
			geo.dispose();
			edges.dispose();
		};
	}, [thin, angle]);
	return <group ref={holder} />;
}

/* ---------- Colours (created once, reused every frame) ---------- */
const C = {
	safe: new THREE.Color("#22D3EE"),
	warn: new THREE.Color("#FBBF24"),
	danger: new THREE.Color("#EF4444"),
	sand: new THREE.Color("#E4D4C4"),
};
const tmp = new THREE.Color();
const out = new THREE.Color();

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (v) => v * v * (3 - 2 * v);

/* Build the water mesh: 64x64 vertices => 63x63 squares => 2 triangles each */
function createGeometry() {
	const geo = new THREE.BufferGeometry();
	geo.setAttribute(
		"position",
		new THREE.BufferAttribute(new Float32Array(N * N * 3), 3),
	);
	geo.setAttribute("aData", new THREE.BufferAttribute(new Float32Array(N * N * 4), 4));
	geo.setAttribute(
		"color",
		new THREE.BufferAttribute(new Float32Array(N * N * 3), 3),
	);
	const idx = [];
	for (let j = 0; j < N - 1; j++)
		for (let i = 0; i < N - 1; i++) {
			const a = j * N + i,
				c = a + N;
			idx.push(a, c, a + 1, a + 1, c, c + 1);
		}
	geo.setIndex(idx);
	return geo;
}

// True if any of the 4 neighbouring cells is a wall/building
function touchesSolid(s, id, i, j) {
	return (
		(i > 0 && s.solid[id - 1] === 1) ||
		(i < N - 1 && s.solid[id + 1] === 1) ||
		(j > 0 && s.solid[id - N] === 1) ||
		(j < N - 1 && s.solid[id + N] === 1)
	);
}

// Distance (in cells) from every cell to the nearest solid cell: 2-pass chamfer
const distToSolid = new Float32Array(N * N);
function updateSolidDistance(s) {
	for (let id = 0; id < N * N; id++) distToSolid[id] = s.solid[id] ? 0 : 1e3;
	for (let j = 0; j < N; j++)
		for (let i = 0; i < N; i++) {
			const id = j * N + i;
			let v = distToSolid[id];
			if (i > 0) v = Math.min(v, distToSolid[id - 1] + 1);
			if (j > 0) v = Math.min(v, distToSolid[id - N] + 1);
			if (i > 0 && j > 0) v = Math.min(v, distToSolid[id - N - 1] + 1.414);
			if (i < N - 1 && j > 0) v = Math.min(v, distToSolid[id - N + 1] + 1.414);
			distToSolid[id] = v;
		}
	for (let j = N - 1; j >= 0; j--)
		for (let i = N - 1; i >= 0; i--) {
			const id = j * N + i;
			let v = distToSolid[id];
			if (i < N - 1) v = Math.min(v, distToSolid[id + 1] + 1);
			if (j < N - 1) v = Math.min(v, distToSolid[id + N] + 1);
			if (i < N - 1 && j < N - 1) v = Math.min(v, distToSolid[id + N + 1] + 1.414);
			if (i > 0 && j < N - 1) v = Math.min(v, distToSolid[id + N - 1] + 1.414);
			distToSolid[id] = v;
		}
}

/* Copy solver data (READ-ONLY) into the mesh: heights, heat colour and
   per-vertex water data (depth, foam strength, obstacle damping) for the shaders */
function writeGeometry(geo, s, heat) {
	const pos = geo.attributes.position.array;
	const col = geo.attributes.color.array;
	const data = geo.attributes.aData.array;
	updateSolidDistance(s);
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			const id = j * N + i;
			const x = cellPos(i);
			let y = s.b[id] + s.h[id];

			// Solid cells copy the highest neighbouring water level so water touches them cleanly
			if (s.solid[id]) {
				y = s.b[id];
				const nb = [
					i > 0 ? id - 1 : -1,
					i < N - 1 ? id + 1 : -1,
					j > 0 ? id - N : -1,
					j < N - 1 ? id + N : -1,
				];
				for (const n of nb)
					if (n >= 0 && !s.solid[n]) y = Math.max(y, s.b[n] + s.h[n]);
			}
			pos[id * 3] = x;
			pos[id * 3 + 1] = y;
			pos[id * 3 + 2] = cellPos(j);

			const d = s.h[id];
			const speed = d > 0.02 ? Math.hypot(s.hu[id], s.hv[id]) / d : 0;

			// Foam strength 0..1 (smooth ramps; the foam shader cuts the scalloped edge)
			let f = clamp01((speed - 0.55) / 0.95); // fast crests / surge fronts
			f = Math.max(f, 1 - clamp01((d - 0.01) / 0.07)); // shallow waterline
			if (d > 0.01 && touchesSolid(s, id, i, j)) f = Math.max(f, 0.8); // dam + buildings
			if (d > 0.01 && (i === 0 || j === 0 || i === N - 1 || j === N - 1))
				f = Math.max(f, 0.8); // tank edges
			const foam = smooth(f) * smooth(clamp01((d - 0.004) / 0.02)) * 0.9;

			data[id * 4] = d;
			data[id * 4 + 1] = foam;
			data[id * 4 + 2] = smooth(clamp01((distToSolid[id] - 1.5) / 5));
			data[id * 4 + 3] = 0;

			// Hazard Heatmap colour (cyan-amber-red), sand where dry
			if (heat) {
				const near = 0.7 + 0.3 * smooth(clamp01(x));
				const r = Math.min(
					1,
					((d * speed) / 0.3) * near + 0.15 * clamp01(d / 0.9),
				);
				if (r < 0.5) tmp.lerpColors(C.safe, C.warn, r * 2);
				else tmp.lerpColors(C.warn, C.danger, (r - 0.5) * 2);
				out.copy(C.sand).lerp(tmp, smooth(clamp01((d - 0.004) / 0.05)));
				col[id * 3] = out.r;
				col[id * 3 + 1] = out.g;
				col[id * 3 + 2] = out.b;
			}
		}
	}
	geo.attributes.position.needsUpdate = true;
	geo.attributes.color.needsUpdate = true;
	geo.attributes.aData.needsUpdate = true;
	geo.computeVertexNormals();
}

/* ---------- Modern hydroelectric dam parts ----------
   Everything is positioned relative to a pivot at the dam's downstream toe, so a whole
   segment (body, ribs, deck, rails, towers) can topple together in a breach. */
const CONCRETE = "#E4DBCB";
const CONCRETE_DK = "#CFBEA2";
const SLATE = "#262726";
const damGeoCache = {};
// Battered (sloped) downstream face: wide base, narrow crest. Extruded along Z.
function damBodyGeo(len) {
	const key = Math.round(len * 1000);
	if (!damGeoCache[key]) {
		const sh = new THREE.Shape();
		sh.moveTo(-0.55, 0);
		sh.lineTo(0, 0);
		sh.lineTo(-0.3, WALL_H);
		sh.lineTo(-0.55, WALL_H);
		sh.closePath();
		const g = new THREE.ExtrudeGeometry(sh, { depth: len, bevelEnabled: false });
		g.translate(0, 0, -len / 2);
		damGeoCache[key] = g;
	}
	return damGeoCache[key];
}
// Triangular buttress rib hugging the downstream face
const RIB_GEO = (() => {
	const sh = new THREE.Shape();
	sh.moveTo(-0.3, 0);
	sh.lineTo(0.12, 0);
	sh.lineTo(-0.27, WALL_H * 0.9);
	sh.lineTo(-0.3, WALL_H * 0.9);
	sh.closePath();
	const g = new THREE.ExtrudeGeometry(sh, { depth: 0.16, bevelEnabled: false });
	g.translate(0, 0, -0.08);
	return g;
})();

function DamBody({ len, color = CONCRETE }) {
	return (
		<mesh geometry={damBodyGeo(len)} castShadow receiveShadow>
			<Toon color={color} />
			<Ink />
		</mesh>
	);
}
function Rib({ z }) {
	return (
		<mesh geometry={RIB_GEO} position={[0, 0, z]} castShadow receiveShadow>
			<Toon color={CONCRETE_DK} />
			<Ink thin />
		</mesh>
	);
}
// Cantilevered crest roadway with slate guardrails
function DamTop({ len }) {
	const posts = [];
	for (let z = -len / 2 + 0.12; z <= len / 2 - 0.1; z += 0.3) posts.push(z);
	return (
		<group>
			<mesh position={[-0.38, WALL_H + 0.04, 0]} castShadow receiveShadow>
				<boxGeometry args={[0.62, 0.08, len]} />
				<Toon color="#F1ECE3" />
				<Ink thin />
			</mesh>
			<mesh position={[-0.38, WALL_H + 0.086, 0]}>
				<boxGeometry args={[0.3, 0.012, len - 0.04]} />
				<Toon color="#69838E" />
			</mesh>
			{[-0.66, -0.1].map((x) => (
				<group key={x}>
					{posts.map((z) => (
						<mesh key={z} position={[x, WALL_H + 0.18, z]} castShadow>
							<boxGeometry args={[0.04, 0.2, 0.04]} />
							<Toon color={SLATE} />
							<Ink thin />
						</mesh>
					))}
					<mesh position={[x, WALL_H + 0.27, 0]}>
						<boxGeometry args={[0.03, 0.03, len]} />
						<Toon color={SLATE} />
						<Ink thin />
					</mesh>
				</group>
			))}
		</group>
	);
}
// Ordinary spillway segment: sloped body + crest deck + buttress rib on its outer edge
function DamSegment({ zc }) {
	return (
		<group>
			<DamBody len={CHUNK_W - 0.01} />
			<DamTop len={CHUNK_W - 0.01} />
			<Rib z={Math.sign(zc) * (CHUNK_W / 2 - 0.0)} />
		</group>
	);
}
// Centre segment: ribbed steel gate (lifts) framed by two tall hoist towers + crossbeam bridge
function GateSegment({ gateRef }) {
	return (
		<group>
			{[-0.65, 0.65].map((z) => (
				<mesh key={z} position={[-0.38, 1.18, z]} castShadow receiveShadow>
					<boxGeometry args={[0.6, 2.36, 0.2]} />
					<Toon color="#F1ECE3" />
					<Ink />
				</mesh>
			))}
			{/* crossbeam bridge + hoist drums + control cabin */}
			<mesh position={[-0.38, 2.28, 0]} castShadow>
				<boxGeometry args={[0.55, 0.14, 1.5]} />
				<Toon color="#F1ECE3" />
				<Ink />
			</mesh>
			{[-0.3, 0.3].map((z) => (
				<mesh key={z} position={[-0.38, 2.43, z]} rotation={[Math.PI / 2, 0, 0]}>
					<cylinderGeometry args={[0.07, 0.07, 0.16, 10]} />
					<Toon color="#B0BFC6" />
					<Ink thin />
				</mesh>
			))}
			<mesh position={[-0.38, 2.5, 0.65]} castShadow>
				<boxGeometry args={[0.4, 0.28, 0.3]} />
				<Toon color="#F9F7F3" />
				<Ink />
			</mesh>
			<mesh position={[-0.17, 2.52, 0.65]}>
				<boxGeometry args={[0.02, 0.12, 0.18]} />
				<Toon color="#CAFAFF" />
				<Ink thin />
			</mesh>
			{/* steel gate: this sub-group is what rises in "sluice" mode */}
			<group ref={gateRef}>
				<mesh position={[-0.45, WALL_H / 2, 0]} castShadow receiveShadow>
					<boxGeometry args={[0.2, WALL_H, 1.1]} />
					<Toon color="#69838E" />
					<Ink />
				</mesh>
				{[0.2, 0.55, 0.9].map((y) => (
					<mesh key={y} position={[-0.32, y, 0]}>
						<boxGeometry args={[0.06, 0.07, 1.08]} />
						<Toon color="#B0BFC6" />
						<Ink thin />
					</mesh>
				))}
				{[-0.3, 0.3].map((z) => (
					<mesh key={z} position={[-0.32, WALL_H / 2, z]}>
						<boxGeometry args={[0.06, WALL_H - 0.06, 0.06]} />
						<Toon color="#B0BFC6" />
						<Ink thin />
					</mesh>
				))}
			</group>
		</group>
	);
}
// Breach rubble: clustered, tilted concrete slabs [x, y, z, w, h, d, rx, ry, rz]
const SLABS = [
	[0.0, 0.08, -0.3, 0.5, 0.09, 0.4, 0.12, 0.4, 0.28],
	[0.18, 0.1, 0.15, 0.42, 0.08, 0.36, -0.2, -0.3, 0.4],
	[-0.12, 0.14, 0.38, 0.34, 0.08, 0.3, 0.3, 0.7, -0.25],
];
function Rubble() {
	return (
		<group>
			{SLABS.map(([x, y, z, w, h, d, rx, ry, rz], i) => (
				<mesh key={i} position={[x, y, z]} rotation={[rx, ry, rz]} castShadow receiveShadow>
					<boxGeometry args={[w, h, d]} />
					<Toon color={i % 2 ? "#E4DBCB" : CONCRETE_DK} />
					<Ink thin />
				</mesh>
			))}
		</group>
	);
}

/* ---------- Props ---------- */
function Tree({ x, z, s, gRef }) {
	return (
		<group ref={gRef} position={[x, bedHeight(x) - 0.02, z]} scale={s}>
			<mesh position={[0, 0.08, 0]} castShadow>
				<cylinderGeometry args={[0.035, 0.045, 0.16, 6]} />
				<Toon color="#C09577" />
				<Ink thin />
			</mesh>
			{/* three stacked cones: [radius, height, y] */}
			{[
				[0.22, 0.26, 0.27, "#92C3AC"],
				[0.17, 0.24, 0.43, "#63A488"],
				[0.11, 0.22, 0.58, "#499577"],
			].map(([r, h, y, c], i) => (
				<mesh key={i} position={[0, y, 0]} castShadow>
					<coneGeometry args={[r, h, 7]} />
					<Toon color={c} />
					<Ink thin />
				</mesh>
			))}
		</group>
	);
}

function Lamp({ x, z }) {
	return (
		<group position={[x, bedHeight(x) - 0.02, z]}>
			<mesh position={[0, 0.25, 0]} castShadow>
				<cylinderGeometry args={[0.018, 0.024, 0.5, 6]} />
				<Toon color="#69838E" />
				<Ink thin />
			</mesh>
			<mesh position={[0, 0.54, 0]}>
				<sphereGeometry args={[0.055, 8, 6]} />
				<Toon
					color="#FFF1B8"
					emissive="#FFD66B"
					emissiveIntensity={0.9}
				/>
				<Ink thin />
			</mesh>
			<mesh position={[0, 0.62, 0]} castShadow>
				<coneGeometry args={[0.075, 0.06, 6]} />
				<Toon color="#69838E" />
				<Ink thin />
			</mesh>
		</group>
	);
}

/* ---------- Modern buildings ----------
   Footprints/heights come from BUILDINGS (solver), so flood collisions stay aligned.
   B = a toon box with ink. y = height of its bottom above the pad; flash = ref-callback that
   registers the material for the impact flash. */
const GLASS = "#CAFAFF";
const CONC = "#F1ECE3";
const reg = (store, i) => (r) => {
	if (r) (store.current[i] ??= new Set()).add(r);
};
function B({ x = 0, y = 0, z = 0, w, h, d, c, flash, thin, rot, cast = true }) {
	return (
		<mesh position={[x, y + h / 2, z]} rotation={rot} castShadow={cast} receiveShadow>
			<boxGeometry args={[w, h, d]} />
			{flash ? (
				<Toon color={c} emissive="#FFFFFF" emissiveIntensity={0} matRef={flash} />
			) : (
				<Toon color={c} />
			)}
			{thin ? <Ink thin /> : <Ink />}
		</mesh>
	);
}
// Shed-roof wedge: high on -X, low on +X, extruded along Z
const shedGeo = (() => {
	const sh = new THREE.Shape();
	sh.moveTo(-0.24, 0);
	sh.lineTo(0.24, 0);
	sh.lineTo(0.24, 0.05);
	sh.lineTo(-0.24, 0.16);
	sh.closePath();
	const g = new THREE.ExtrudeGeometry(sh, { depth: 0.76, bevelEnabled: false });
	g.translate(0, 0, -0.38);
	return g;
})();

// 0: cantilevered villa (footprint 0.8 x 0.7)
function Villa({ bd, bf, rf }) {
	const rail = "#262726";
	return (
		<group>
			<B x={-0.08} w={0.56} d={0.62} h={0.25} c={bd.wall} flash={bf} />
			<B x={0.0} z={-0.05} y={0.25} w={0.8} d={0.5} h={0.26} c={bd.wall} flash={bf} />
			{/* glass strips: ground floor + overhanging upper floor */}
			<B x={0.205} y={0.07} w={0.012} d={0.34} h={0.1} c={GLASS} thin />
			<B x={0.405} y={0.33} w={0.012} d={0.36} h={0.1} c={GLASS} thin />
			<B x={0.0} y={0.33} z={0.205} w={0.62} d={0.012} h={0.1} c={GLASS} thin />
			<B x={-0.15} y={0.0} z={0.315} w={0.12} d={0.012} h={0.17} c="#8A5644" thin />
			{/* balcony in front of the upper floor, slate railing */}
			<B x={-0.04} y={0.25} z={0.265} w={0.64} d={0.1} h={0.025} c={CONC} thin />
			<B x={-0.04} y={0.3} z={0.31} w={0.64} d={0.012} h={0.012} c={rail} thin />
			{[-0.34, -0.15, 0.04, 0.23].map((px) => (
				<B key={px} x={px} y={0.275} z={0.31} w={0.014} d={0.014} h={0.04} c={rail} thin cast={false} />
			))}
			{/* flat roof + parapet + rooftop planter */}
			<B x={0.0} z={-0.05} y={0.51} w={0.82} d={0.52} h={0.03} c={bd.roof} flash={rf} />
			<B x={0.0} z={0.205} y={0.54} w={0.82} d={0.02} h={0.03} c={bd.roof} flash={rf} thin />
			<B x={0.0} z={-0.305} y={0.54} w={0.82} d={0.02} h={0.03} c={bd.roof} flash={rf} thin />
			<B x={-0.14} z={-0.05} y={0.54} w={0.26} d={0.18} h={0.05} c="#C09577" thin />
			<B x={-0.14} z={-0.05} y={0.59} w={0.22} d={0.14} h={0.02} c="#63A488" thin />
			<mesh position={[-0.2, 0.64, -0.05]}>
				<sphereGeometry args={[0.04, 8, 6]} />
				<Toon color="#499577" />
				<Ink thin />
			</mesh>
		</group>
	);
}

// 1: civic / research centre (footprint 0.7 x 0.7)
function Civic({ bd, bf, rf }) {
	const fins = [-0.26, -0.13, 0, 0.13, 0.26];
	return (
		<group>
			<B z={-0.04} w={0.64} d={0.58} h={0.58} c={bd.wall} flash={bf} />
			{/* vertical concrete fins (front +Z, side +X) */}
			{fins.map((f) => (
				<B key={"z" + f} x={f} z={0.275} w={0.04} d={0.05} h={0.58} c={CONC} thin />
			))}
			{[-0.22, -0.04, 0.14].map((f) => (
				<B key={"x" + f} x={0.335} z={f} w={0.05} d={0.04} h={0.58} c={CONC} thin />
			))}
			{/* horizontal ribbon windows */}
			{[0.2, 0.42].map((y) => (
				<group key={y}>
					<B z={0.252} y={y} w={0.56} d={0.012} h={0.07} c={GLASS} thin />
					<B x={0.322} z={-0.04} y={y} w={0.012} d={0.5} h={0.07} c={GLASS} thin />
				</group>
			))}
			{/* entrance canopy on posts + door */}
			<B z={0.33} y={0.2} w={0.3} d={0.14} h={0.03} c={CONC} thin />
			<B x={-0.12} z={0.38} w={0.02} d={0.02} h={0.2} c="#262726" thin cast={false} />
			<B x={0.12} z={0.38} w={0.02} d={0.02} h={0.2} c="#262726" thin cast={false} />
			<B z={0.253} w={0.14} d={0.012} h={0.17} c="#525353" thin />
			{/* roof + angled solar panels */}
			<B z={-0.04} y={0.58} w={0.68} d={0.62} h={0.04} c={bd.roof} flash={rf} />
			{[-0.2, 0, 0.2].map((px) => (
				<B key={px} x={px} z={-0.04} y={0.65} w={0.16} d={0.2} h={0.015} c="#275CA2" thin rot={[-0.45, 0, 0]} cast={false} />
			))}
		</group>
	);
}

// 2: split-level townhouse with shed roof (footprint 0.8 x 0.8)
function Townhouse({ bd, bf, rf }) {
	return (
		<group>
			<B x={-0.175} w={0.45} d={0.7} h={0.46} c={bd.wall} flash={bf} />
			<B x={0.225} z={-0.05} w={0.35} d={0.6} h={0.27} c="#F1ECE3" flash={bf} />
			{/* mono-pitch roof on the tall block */}
			<mesh geometry={shedGeo} position={[-0.175, 0.46, 0]} scale={[0.94, 1, 0.92]} castShadow>
				<Toon color={bd.roof} emissive="#FFFFFF" emissiveIntensity={0} matRef={rf} />
				<Ink />
			</mesh>
			{/* timber terrace deck + rail on the low block */}
			<B x={0.225} z={-0.05} y={0.27} w={0.35} d={0.6} h={0.03} c="#D3B79E" thin />
			<B x={0.385} z={-0.05} y={0.3} w={0.012} d={0.6} h={0.012} c="#262726" thin />
			<B x={0.225} z={-0.35} y={0.3} w={0.35} d={0.012} h={0.012} c="#262726" thin />
			{/* large corner glazing wrapping +Z and +X */}
			<B x={-0.18} y={0.1} z={0.352} w={0.34} d={0.012} h={0.28} c={GLASS} thin />
			<B x={0.225} y={0.06} z={0.254} w={0.26} d={0.012} h={0.14} c={GLASS} thin />
			<B x={0.05} y={0.3} z={0.0} w={0.012} d={0.5} h={0.14} c={GLASS} thin />
		</group>
	);
}

// 3: glass-and-concrete pavilion with setback observation studio (footprint 0.62 x 0.62)
function Pavilion({ bd, bf, rf }) {
	return (
		<group>
			<B w={0.6} d={0.6} h={0.03} c={CONC} thin />
			<B y={0.03} w={0.56} d={0.56} h={0.2} c={GLASS} />
			{[
				[-0.28, -0.28],
				[0.28, -0.28],
				[-0.28, 0.28],
				[0.28, 0.28],
			].map(([px, pz]) => (
				<B key={`${px}${pz}`} x={px} z={pz} y={0.03} w={0.06} d={0.06} h={0.2} c={bd.wall} flash={bf} thin />
			))}
			<B y={0.23} w={0.62} d={0.62} h={0.03} c={CONC} />
			{/* setback observation studio */}
			<B x={-0.05} z={-0.05} y={0.26} w={0.4} d={0.4} h={0.2} c={bd.wall} flash={bf} />
			<B x={0.152} z={-0.05} y={0.3} w={0.012} d={0.3} h={0.1} c={GLASS} thin />
			<B x={-0.05} z={0.152} y={0.3} w={0.3} d={0.012} h={0.1} c={GLASS} thin />
			{/* cantilevered roof + rooftop utility unit */}
			<B x={0.0} z={0.0} y={0.46} w={0.6} d={0.6} h={0.04} c={bd.roof} flash={rf} />
			<B x={-0.12} z={-0.1} y={0.5} w={0.16} d={0.12} h={0.07} c="#B0BFC6" thin />
			<mesh position={[-0.12, 0.575, -0.1]}>
				<cylinderGeometry args={[0.04, 0.04, 0.012, 10]} />
				<Toon color="#525353" />
				<Ink thin />
			</mesh>
		</group>
	);
}
const BUILDING_TYPES = [Villa, Civic, Townhouse, Pavilion];
const BUILDING_PALETTE = [
	{ wall: "#FCCFCC", roof: "#92B9CE" }, // valencia-200 / wedgewood-300
	{ wall: "#FBE48C", roof: "#FFA1A7" }, // lightning-yellow-200 / coral-red-300
	{ wall: "#BEDCCC", roof: "#FF9B72" }, // gossamer-200 / outrageous-orange-300
	{ wall: "#C6D9F1", roof: "#FDD48A" }, // cello-200 / tree-poppy-200
];

// Valley boulders: x, z, scale
const ROCKS = [
	[3.6, -1.5, 1],
	[3.78, -1.3, 0.7],
	[3.52, -1.32, 0.5],
	[2.9, 0.9, 0.9],
	[3.02, 1.0, 0.55],
	[0.7, 1.6, 0.9],
	[0.85, 1.72, 0.55],
	[2.9, -2.5, 0.8],
	[1.4, -0.7, 0.7],
	[1.5, -0.62, 0.45],
];
function Rock({ x, z, s, i, gRef }) {
	return (
		<group ref={gRef} position={[x, bedHeight(x) + 0.03 * s, z]}>
			<mesh
				rotation={[0, i * 1.7, 0]}
				scale={[s, s * 0.62, s * (0.8 + (i % 3) * 0.12)]}
				castShadow
				receiveShadow
			>
				<dodecahedronGeometry args={[0.1, 0]} />
				<Toon color={i % 2 ? "#CFBEA2" : "#BA9E7D"} />
				<Ink thin />
			</mesh>
		</group>
	);
}

// Total water volume over non-solid cells (read-only; called on mount/reset and by telemetry)
function fluidVolume(s) {
	let v = 0;
	for (let id = 0; id < N * N; id++) if (!s.solid[id]) v += s.h[id] * DX * DX;
	return v;
}

export default function WaterTank({ apiRef, wireframe, heat }) {
	const clock = useThree((state) => state.clock);
	const solver = useMemo(() => createSolver(), []);
	const geometry = useMemo(() => {
		const g = createGeometry();
		writeGeometry(g, solver, false);
		return g;
	}, [solver]);

	const mats = useMemo(() => createWaterMaterials(), []);
	const initVolRef = useRef(0); // fluid volume right after solver.reset() (for mass drift)
	const emaStepMs = useRef(0); // smoothed solver.advance() time per frame (ms)
	useLayoutEffect(() => {
		initVolRef.current = fluidVolume(solver);
	}, [solver]);
	const root = useRef(); // whole diorama (shaken on big events)
	const fx = useRef(); // splash/dust particle system
	const pivRefs = useRef([]); // dam chunk pivots (hinge at the downstream bottom edge)
	const gateRef = useRef(); // steel sluice gate (centre segment)
	const rubRefs = useRef([]); // low rubble left behind after the breach
	const bodyMats = useRef([]); // house wall + roof materials (for the flash)
	const roofMats = useRef([]);
	// ----- Intro assembly (plain JS progress values 0..1, animated by anime.js, read in useFrame) -----
	const intro = useMemo(
		() => ({
			base: [{ p: 0 }],
			dam: Array.from({ length: CHUNKS.length + 2 }, () => ({ p: 0 })),
			town: BUILDINGS.map(() => ({ p: 0 })),
			props: Array.from({ length: TREES.length + ROCKS.length }, () => ({ p: 0 })),
		}),
		[],
	);
	const baseRefs = useRef([]); // plinth+water group, retaining walls+lamps group
	const absRefs = useRef([]); // fixed dam abutments
	const townRefs = useRef([]);
	const rockRefs = useRef([]);
	useLayoutEffect(() => {
		const every = [...intro.base, ...intro.dam, ...intro.town, ...intro.props];
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
			every.forEach((o) => (o.p = 1));
			return;
		}
		every.forEach((o) => (o.p = 0));
		const tl = createTimeline();
		tl.add(intro.base, { p: [0, 1], duration: 380, ease: "outCubic" }, 0)
			.add(intro.dam, { p: [0, 1], duration: 380, ease: "outBack(1.2)", delay: stagger(55) }, 180)
			.add(intro.town, { p: [0, 1], duration: 380, ease: "outBack(1.8)", delay: stagger(65) }, 520)
			.add(intro.props, { p: [0, 1], duration: 330, ease: "outBack(1.8)", delay: stagger(15) }, 600);
		return () => {
			tl.revert();
			every.forEach((o) => (o.p = 1)); // never leave anything collapsed (StrictMode safe)
		};
	}, [intro]);

	const treeRefs = useRef([]); // tree groups (swayed by floodwater)
	const treeSpring = useMemo(() => new Float32Array(TREES.length * 2), []); // [lean, velocity] per tree
	const shake = useRef(0); // shake strength, decays to 0
	const dam = useRef({ mode: "intact", start: 0, fired: false, landed: [] }); // intact | sluice | breach
	const cool = useMemo(() => new Float32Array(N * N), []); // per-cell splash cooldown
	const flash = useMemo(() => new Float32Array(BUILDINGS.length), []); // per-house flash 0..1

	const bump = useCallback(
		(x, z, amp) => solver.addBump(x, z, amp),
		[solver],
	);

	// Functions used by the HUD buttons (they live outside <Canvas>)
	useImperativeHandle(
		apiRef,
		() => ({
			openGate() {
				if (dam.current.mode === "intact")
					dam.current = {
						mode: "sluice",
						start: clock.elapsedTime,
						fired: false,
						landed: [],
					};
			},
			breach() {
				if (dam.current.mode !== "breach")
					dam.current = {
						mode: "breach",
						start: clock.elapsedTime,
						fired: false,
						landed: [],
					};
			},
			// Read-only snapshot for the telemetry drawer (only runs when called, ~every 150ms)
			getTelemetry() {
				const v0 = initVolRef.current;
				let maxDepth = 0;
				let peak = 0;
				let wet = 0;
				let valley = 0;
				for (let j = 0; j < N; j++)
					for (let i = 0; i < N; i++) {
						const id = j * N + i;
						if (solver.solid[id]) continue;
						const d = solver.h[id];
						if (d > 0.02) {
							const sp = Math.hypot(solver.hu[id], solver.hv[id]) / d;
							if (sp > peak) peak = sp;
						}
						if (cellPos(i) > DAM_X) {
							valley++;
							if (d > maxDepth) maxDepth = d;
							if (d > 0.02) wet++;
						}
					}
				return {
					massDriftPct: ((fluidVolume(solver) - v0) / Math.max(v0, 1e-6)) * 100,
					maxDownstreamDepth: maxDepth,
					peakVelocity: peak,
					wetCoveragePct: valley ? (wet / valley) * 100 : 0,
					stepMs: emaStepMs.current,
				};
			},
			dropWave() {
				bump(
					(Math.random() * 2 - 1) * 3.4,
					(Math.random() * 2 - 1) * 3.4,
					0.25,
				);
			},
			reset() {
				solver.reset();
				initVolRef.current = fluidVolume(solver); // new baseline for the mass-drift readout
				cool.fill(0);
				flash.fill(0);
				dam.current = {
					mode: "intact",
					start: 0,
					fired: false,
					landed: [],
				};
			},
		}),
		[solver, bump, clock, cool, flash, initVolRef, emaStepMs],
	);

	// Look for fast water hitting a wall/building and pop droplets (max 4 hits per frame)
	function emitSplashes(t) {
		if (!fx.current) return;
		const M = N * N;
		const first = Math.floor(t * 60 * 997) % M; // rotate the scan start so no area is favoured
		let hits = 0;
		for (let n = 0; n < M && hits < 4; n++) {
			const id = (first + n) % M;
			const d = solver.h[id];
			if (solver.solid[id] || d < 0.03 || cool[id] > t) continue;
			const vx = solver.hu[id] / d;
			const vz = solver.hv[id] / d;
			if (vx * vx + vz * vz < 1) continue; // only fast water (> 1 unit/s)
			const i = id % N;
			const j = (id / N) | 0;
			if (!touchesSolid(solver, id, i, j)) continue;
			cool[id] = t + 0.3;
			hits++;
			const x = cellPos(i);
			const z = cellPos(j);
			for (let k = 0; k < 3; k++)
				fx.current.spawn("drop", x, solver.b[id] + d + 0.03, z, vx, vz);
			// If this wall belongs to a house, make that house flash
			BUILDINGS.forEach((bd, k) => {
				if (
					Math.abs(x - bd.x) <= bd.w / 2 + DX * 1.5 &&
					Math.abs(z - bd.z) <= bd.d / 2 + DX * 1.5
				)
					flash[k] = 1;
			});
		}
	}

	// Runs every frame (~60 FPS)
	useFrame(({ clock, gl, size }, delta) => {
		const t = clock.elapsedTime;
		// Keep outline widths constant in screen pixels (LineMaterial needs the real buffer size)
		gl.getDrawingBufferSize(pxSize);
		const k = pxSize.x / size.width; // device pixel ratio
		inkMat.resolution.copy(pxSize);
		inkThin.resolution.copy(pxSize);
		inkMat.linewidth = INK_PX * k;
		inkThin.linewidth = THIN_PX * k;
		const { mode, start, landed } = dam.current;
		const age = t - start;
		let lift = 0; // how far the sluice gate has risen (0..1)
		let openHalf = 0; // how much of the dam (half-width) the solver has opened in a breach

		if (mode === "sluice") {
			lift = smooth(Math.min(age / 1, 1));
			if (lift > 0.3) {
				solver.openDam(CHUNK_W / 2, 0); // gap opens once the gate clears the water
				if (!dam.current.fired) {
					dam.current.fired = true; // one-time "slam": shake + dust puff
					shake.current = 1;
					for (let k = 0; k < 14; k++)
						fx.current?.spawn(
							"dust",
							DAM_X + 0.2,
							0.15,
							(Math.random() - 0.5) * 1.0,
						);
				}
			}
		} else if (mode === "breach") {
			// Chunks start falling ring by ring (centre first); the solver opens the same rows
			let rings = 0;
			for (const zc of CHUNKS)
				if (age >= ring(zc) * 0.3 + 0.1)
					rings = Math.max(rings, ring(zc) + 1);
			if (rings > 0) {
				openHalf =
					rings === 3 ? 3.1 : CHUNK_W / 2 + CHUNK_W * (rings - 1);
				solver.openDam(openHalf, RUBBLE);
			}
			if (!dam.current.fired) {
				dam.current.fired = true;
				shake.current = 1.6;
			}
			if (age < 1.4 && openHalf > 0 && Math.random() < 0.6)
				// dust along the crumbling wall
				fx.current?.spawn(
					"dust",
					DAM_X,
					0.2 + Math.random() * 0.5,
					(Math.random() * 2 - 1) * openHalf,
				);
		}

		// Animate the 5 dam chunks
		CHUNKS.forEach((zc, k) => {
			const g = pivRefs.current[k];
			const rub = rubRefs.current[k];
			if (!g) return;
			const io = (1 - intro.dam[k].p) * 0.6; // intro drop-in offset (0 once settled)
			// default = intact wall
			g.position.y = -0.02 + io;
			g.rotation.set(0, 0, 0);
			g.scale.setScalar(1);
			g.visible = true;
			if (rub) rub.visible = false;

			if (zc === 0 && gateRef.current)
				gateRef.current.position.y = mode === "sluice" ? lift * 0.95 : 0; // gate rises, towers stay

			if (mode === "breach") {
				const ts = ring(zc) * 0.3; // when this chunk starts to fall
				const u = clamp01((age - ts) / 0.55); // 0..1 toppling
				const v = clamp01((age - ts - 0.55) / 0.8); // 0..1 sinking away after landing
				const sgn = k % 2 ? 1 : -1; // alternate the tumble direction
				// Tip forward (downstream, +X) around the bottom edge, speeding up as it falls, with a little twist
				g.rotation.set(0.2 * u * sgn, 0.25 * u * -sgn, -1.15 * u * u);
				g.position.y = -0.02 - v * 0.35 + io;
				g.scale.setScalar(Math.max(0.001, 1 - v));
				g.visible = v < 1;
				if (rub) rub.visible = age >= ts + 0.45; // rubble appears as the chunk lands
				if (u >= 1 && !landed[k]) {
					landed[k] = true; // landing thump: dust + small shake
					shake.current = Math.max(shake.current, 0.7);
					for (let n = 0; n < 8; n++)
						fx.current?.spawn(
							"dust",
							DAM_X + 0.4,
							0.15,
							zc + (Math.random() - 0.5) * CHUNK_W,
						);
				}
			}
		});

		const t0 = performance.now();
		solver.advance(Math.min(delta, 1 / 30));
		const stepMs = performance.now() - t0;
		emaStepMs.current += (stepMs - emaStepMs.current) * 0.1; // smoothed solver cost per frame
		writeGeometry(geometry, solver, heat);
		mats.uniforms.uTime.value = t;
		mats.uniforms.uHeat.value = heat ? 1 : 0;
		mats.water.wireframe = wireframe;
		emitSplashes(t);

		// Trees lean downstream when floodwater reaches them (damped spring; solver arrays are read only)
		const sdt = Math.min(delta, 1 / 30);
		TREES.forEach((tr, n) => {
			const g = treeRefs.current[n];
			if (!g) return;
			const ci = Math.min(N - 1, Math.max(0, Math.round((tr.x + SIZE / 2) / DX)));
			const cj = Math.min(N - 1, Math.max(0, Math.round((tr.z + SIZE / 2) / DX)));
			const id = cj * N + ci;
			const d = solver.solid[id] ? 0 : solver.h[id];
			let target = 0;
			let dx = 1;
			let dz = 0;
			if (d > 0.03) {
				const vx = solver.hu[id] / d;
				const vz = solver.hv[id] / d;
				const sp = Math.hypot(vx, vz);
				target = Math.min(0.55, 0.12 + clamp01(d / 0.5) * 0.12 + sp * 0.18);
				if (sp > 0.05) {
					dx = 0.6 + (0.4 * vx) / sp; // bias toward +X (downstream), follow the flow a bit
					dz = (0.4 * vz) / sp;
				}
			}
			let lean = treeSpring[n * 2];
			let vel = treeSpring[n * 2 + 1];
			vel += (70 * (target - lean) - 5 * vel) * sdt; // spring + damping
			lean += vel * sdt;
			treeSpring[n * 2] = lean;
			treeSpring[n * 2 + 1] = vel;
			g.rotation.set(lean * dz, 0, -lean * dx);
			g.scale.setScalar(Math.max(0.001, intro.props[n].p) * tr.s); // intro pop
		});

		// Intro assembly (read-only progress values; all exactly 1 once settled)
		const ib = intro.base[0].p;
		for (const bg of baseRefs.current)
			if (bg) {
				bg.position.y = -0.35 * (1 - ib);
				bg.scale.setScalar(0.94 + 0.06 * ib);
			}
		absRefs.current.forEach((g, n) => {
			if (g) g.position.y = -0.02 + (1 - intro.dam[CHUNKS.length + n].p) * 0.6;
		});
		townRefs.current.forEach((g, n) => {
			if (g) g.scale.set(1, Math.max(0.001, intro.town[n].p), 1);
		});
		rockRefs.current.forEach((g, n) => {
			if (g) g.scale.setScalar(Math.max(0.001, intro.props[TREES.length + n].p));
		});

		// House flash fades out quickly
		for (let k = 0; k < flash.length; k++) {
			flash[k] = Math.max(0, flash[k] - delta * 3);
			const e = flash[k] * 0.5;
			for (const m of bodyMats.current[k] ?? []) m.emissiveIntensity = e;
			for (const m of roofMats.current[k] ?? []) m.emissiveIntensity = e;
		}

		// Shake the whole diorama (simpler and safer than moving the camera)
		shake.current *= Math.exp(-delta * 5);
		const amp = shake.current > 0.002 ? 0.035 * shake.current : 0;
		root.current?.position.set(
			Math.sin(t * 55) * amp,
			0,
			Math.cos(t * 47) * amp,
		);
	});

	const rimHalf = SIZE / 2 + RIM_T / 2;
	const wallOuter = rimHalf + RIM_T / 2 + 0.008; // panel inset plane
	const panelPos = [-3, -1, 1, 3];
	const corners = [
		[1, 1],
		[1, -1],
		[-1, 1],
		[-1, -1],
	];

	return (
		<group ref={root}>
			<group ref={(g) => (baseRefs.current[0] = g)}>
				{/* Stepped plinth: wide base slab, dark slate reveal band, upper slab (top just below y = 0) */}
				<mesh position={[0, -0.23, 0]} castShadow receiveShadow>
					<boxGeometry args={[SIZE + 2, 0.14, SIZE + 2]} />
					<Toon color="#E4DBCB" />
					<Ink />
				</mesh>
				<mesh position={[0, -0.135, 0]}>
					<boxGeometry args={[SIZE + 1.35, 0.07, SIZE + 1.35]} />
					<Toon color="#262726" />
					<Ink thin />
				</mesh>
				<mesh position={[0, -0.06, 0]} castShadow receiveShadow>
					<boxGeometry args={[SIZE + 1.7, 0.08, SIZE + 1.7]} />
					<Toon color="#F1ECE3" />
					<Ink />
				</mesh>

				{/* Water + terrain surface, driven by the solver. Click to drop a wave. No outline. */}
				<mesh
					geometry={geometry}
					frustumCulled={false}
					onClick={(e) => {
						e.stopPropagation();
						bump(e.point.x, e.point.z, 0.22); // world coords match the solver grid
					}}
					onPointerOver={() => (document.body.style.cursor = "pointer")}
					onPointerOut={() => (document.body.style.cursor = "auto")}
				>
					<primitive object={mats.water} attach="material" />
				</mesh>

				{/* Foam overlay: same grid, lifted +0.006 with polygonOffset; never blocks clicks */}
				<mesh
					geometry={geometry}
					material={mats.foam}
					frustumCulled={false}
					renderOrder={1}
					raycast={() => null}
				/>
			</group>

			{/* Modern dam: 5 functional segments, each pivoting at its downstream toe so it can topple */}
			{CHUNKS.map((zc, k) => (
				<group
					key={k}
					ref={(g) => (pivRefs.current[k] = g)}
					position={[DAM_X + TOE, -0.02, zc]}
				>
					{zc === 0 ? <GateSegment gateRef={gateRef} /> : <DamSegment zc={zc} />}
				</group>
			))}

			{/* Fixed concrete abutments close the dam out to the tank walls (|z| 3..4) */}
			{[-1, 1].map((sg) => (
				<group
					key={sg}
					ref={(g) => (absRefs.current[sg > 0 ? 1 : 0] = g)}
					position={[DAM_X + TOE, -0.02, sg * 3.5]}
				>
					<DamBody len={1.0} />
					<DamTop len={1.0} />
				</group>
			))}

			{/* Rubble left behind after a breach (hidden until then) */}
			{CHUNKS.map((zc, k) => (
				<group
					key={k}
					ref={(m) => (rubRefs.current[k] = m)}
					visible={false}
					position={[DAM_X + 0.15, -0.02, zc]}
				>
					<Rubble />
				</group>
			))}

			{/* Downstream Town: 4 modern buildings, each on a thin concrete pad flush with the ground */}
			{BUILDINGS.map((bd, i) => {
				const Type = BUILDING_TYPES[i % BUILDING_TYPES.length];
				return (
					<group
						key={i}
						ref={(g) => (townRefs.current[i] = g)}
						position={[bd.x, bedHeight(bd.x) + 0.03, bd.z]}
					>
						<mesh position={[0, -0.04, 0]} receiveShadow>
							<boxGeometry args={[bd.w + 0.25, 0.08, bd.d + 0.25]} />
							<Toon color="#F1ECE3" />
							<Ink thin />
						</mesh>
						<Type
							bd={{ ...bd, ...BUILDING_PALETTE[i % BUILDING_PALETTE.length] }}
							bf={reg(bodyMats, i)}
							rf={reg(roofMats, i)}
						/>
					</group>
				);
			})}

			{/* Comic river boulders on the dry valley slope */}
			{ROCKS.map(([x, z, s], i) => (
				<Rock key={i} x={x} z={z} s={s} i={i} gRef={(g) => (rockRefs.current[i] = g)} />
			))}

			{/* Pine trees and streetlamps (decorative: water flows around them visually only) */}
			{TREES.map((tr, i) => (
				<Tree key={i} {...tr} gRef={(g) => (treeRefs.current[i] = g)} />
			))}
			<group ref={(g) => (baseRefs.current[1] = g)}>
				{LAMPS.map((lp, i) => (
					<Lamp key={i} {...lp} />
				))}

				{/* Heavy retaining walls with overhanging coping, recessed panels and corner pilasters */}
				{[1, -1].map((sg) => (
					<group key={sg}>
						<mesh position={[0, RIM_H / 2 - 0.02, sg * rimHalf]} castShadow receiveShadow>
							<boxGeometry args={[SIZE + RIM_T * 2, RIM_H, RIM_T]} />
							<Toon color="#F1ECE3" />
							<Ink />
						</mesh>
						<mesh position={[0, RIM_H + 0.02, sg * rimHalf]} castShadow>
							<boxGeometry args={[SIZE + RIM_T * 2, 0.08, RIM_T + 0.12]} />
							<Toon color="#F9F7F3" />
							<Ink />
						</mesh>
						<mesh position={[sg * rimHalf, RIM_H / 2 - 0.02, 0]} castShadow receiveShadow>
							<boxGeometry args={[RIM_T, RIM_H, SIZE]} />
							<Toon color="#F1ECE3" />
							<Ink />
						</mesh>
						<mesh position={[sg * rimHalf, RIM_H + 0.022, 0]} castShadow>
							<boxGeometry args={[RIM_T + 0.12, 0.08, SIZE]} />
							<Toon color="#F9F7F3" />
							<Ink />
						</mesh>
						{panelPos.map((p) => (
							<group key={p}>
								<mesh position={[p, RIM_H * 0.5, sg * wallOuter]}>
									<boxGeometry args={[1.5, 0.46, 0.016]} />
									<Toon color="#E4DBCB" />
									<Ink thin />
								</mesh>
								<mesh position={[sg * wallOuter, RIM_H * 0.5, p]}>
									<boxGeometry args={[0.016, 0.46, 1.5]} />
									<Toon color="#E4DBCB" />
									<Ink thin />
								</mesh>
							</group>
						))}
					</group>
				))}
				{corners.map(([cx, cz]) => (
					<group key={`${cx}${cz}`} position={[cx * rimHalf, 0, cz * rimHalf]}>
						<mesh position={[0, (RIM_H + 0.2) / 2 - 0.02, 0]} castShadow receiveShadow>
							<boxGeometry args={[0.44, RIM_H + 0.2, 0.44]} />
							<Toon color="#F1ECE3" />
							<Ink />
						</mesh>
						<mesh position={[0, RIM_H + 0.215, 0]} castShadow>
							<boxGeometry args={[0.54, 0.07, 0.54]} />
							<Toon color="#F9F7F3" />
							<Ink />
						</mesh>
					</group>
				))}
			</group>

			{/* Splash droplets + dust puffs */}
			<Splashes fxRef={fx} />
		</group>
	);
}
