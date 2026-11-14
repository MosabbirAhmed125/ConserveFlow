import { useRef, useMemo, useEffect, useImperativeHandle } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const MAX = 90; // size of the particle pool (old particles are recycled)
const WHITE = new THREE.Color("#F9FAFA");
const CYAN = new THREE.Color("#9BF5FF");
const BLUE = new THREE.Color("#72D6D6");
const DUST = new THREE.Color("#E4D4C4");
const WATER_COLORS = [WHITE, CYAN, BLUE];
const OUT_PX = 0.011; // ink outline thickness (world units)

// hard 2-step cel gradient (no blending between steps)
const gradient = (() => {
	const t = new THREE.DataTexture(
		new Uint8Array([150, 255]),
		2,
		1,
		THREE.RedFormat,
	);
	t.minFilter = t.magFilter = THREE.NearestFilter;
	t.needsUpdate = true;
	return t;
})();

/* Comic droplets and dust puffs: cel-shaded spheres wrapped in an inverted-hull ink outline.
   "drop" = splash droplets, "dust" = puffs.
   Parent calls fxRef.current.spawn(kind, x, y, z, flowVx, flowVz). */
export default function Splashes({ fxRef }) {
	const mesh = useRef();
	const outline = useRef(); // slightly larger back-face shell = ink outline
	const dummy = useMemo(() => new THREE.Object3D(), []);
	const p = useMemo(
		() => ({
			pos: new Float32Array(MAX * 3),
			vel: new Float32Array(MAX * 3),
			life: new Float32Array(MAX), // seconds left (<= 0 means unused)
			max: new Float32Array(MAX).fill(1),
			size: new Float32Array(MAX),
			grav: new Float32Array(MAX),
			next: 0,
		}),
		[],
	);

	// Give every instance a colour slot up front
	useEffect(() => {
		for (let i = 0; i < MAX; i++) mesh.current.setColorAt(i, WHITE);
		mesh.current.instanceColor.needsUpdate = true;
	}, []);

	useImperativeHandle(
		fxRef,
		() => ({
			spawn(kind, x, y, z, vx = 0, vz = 0) {
				const i = p.next;
				p.next = (i + 1) % MAX;
				const dust = kind === "dust";
				const r = Math.random;
				p.pos.set([x, y, z], i * 3);
				p.vel.set(
					dust
						? [
								(r() - 0.5) * 0.6,
								0.3 + r() * 0.5,
								(r() - 0.5) * 0.6,
							]
						: [
								vx * 0.3 + (r() - 0.5) * 0.8,
								1.3 + r() * 1.4,
								vz * 0.3 + (r() - 0.5) * 0.8,
							],
					i * 3,
				);
				p.life[i] = p.max[i] = dust ? 0.9 + r() * 0.5 : 0.7 + r() * 0.5;
				p.size[i] = dust ? 0.07 + r() * 0.05 : 0.035 + r() * 0.03;
				p.grav[i] = dust ? -0.3 : -6;
				mesh.current.setColorAt(
					i,
					dust ? DUST : WATER_COLORS[(r() * 3) | 0],
				);
				mesh.current.instanceColor.needsUpdate = true;
			},
		}),
		[p],
	);

	useFrame((_, delta) => {
		const m = mesh.current;
		const o = outline.current;
		if (!m || !o) return;
		const dt = Math.min(delta, 1 / 30);
		for (let i = 0; i < MAX; i++) {
			if (p.life[i] > 0) {
				p.life[i] -= dt;
				p.vel[i * 3 + 1] += p.grav[i] * dt; // gravity
				for (let a = 0; a < 3; a++)
					p.pos[i * 3 + a] += p.vel[i * 3 + a] * dt;
				// Shrink away during the last 40% of life
				const s =
					p.size[i] *
					Math.min(1, Math.max(0, p.life[i]) / (p.max[i] * 0.4));
				const sy = p.grav[i] < -1 ? s * 1.35 : s; // droplets are teardrop-ish
				dummy.position.set(
					p.pos[i * 3],
					p.pos[i * 3 + 1],
					p.pos[i * 3 + 2],
				);
				dummy.scale.set(s, sy, s);
				dummy.updateMatrix();
				m.setMatrixAt(i, dummy.matrix);
				// ink shell: same shape, a constant thickness larger (hidden once the particle is gone)
				const k = s > 0.002 ? OUT_PX : 0;
				dummy.scale.set(s + k, sy + k, s + k);
				dummy.updateMatrix();
				o.setMatrixAt(i, dummy.matrix);
			} else {
				dummy.scale.setScalar(0); // hidden
				dummy.updateMatrix();
				m.setMatrixAt(i, dummy.matrix);
				o.setMatrixAt(i, dummy.matrix);
			}
		}
		m.instanceMatrix.needsUpdate = true;
		o.instanceMatrix.needsUpdate = true;
	});

	return (
		<>
			<instancedMesh
				ref={mesh}
				args={[undefined, undefined, MAX]}
				frustumCulled={false}
				raycast={() => null}
			>
				<icosahedronGeometry args={[1, 1]} />
				<meshToonMaterial gradientMap={gradient} color="#ffffff" />
			</instancedMesh>
			<instancedMesh
				ref={outline}
				args={[undefined, undefined, MAX]}
				frustumCulled={false}
				raycast={() => null}
			>
				<icosahedronGeometry args={[1, 1]} />
				<meshBasicMaterial color="#191A19" side={THREE.BackSide} />
			</instancedMesh>
		</>
	);
}
