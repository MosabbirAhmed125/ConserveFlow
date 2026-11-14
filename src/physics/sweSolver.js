/* ============================================================
   2D Shallow-Water solver (finite-volume, Rusanov flux)
   ------------------------------------------------------------
   Every grid cell stores:  h  = water depth
                            hu = depth * velocity in X
                            hv = depth * velocity in Z
   b = ground height (bed), solid = 1 for walls/buildings.
   Each step, water "flux" is computed across every cell face and
   added to one cell while removed from its neighbour, so water is
   conserved. "Hydrostatic reconstruction" keeps still water still
   even over a sloped bed. Solid cells and the tank border act as
   mirrors, so waves bounce off them and wrap around buildings.
   ============================================================ */

export const N = 64; // 64 x 64 cells == 64 x 64 mesh vertices
export const SIZE = 8; // tank width/depth in world units
export const DX = SIZE / (N - 1); // distance between cell centres

export const DAM_X = -1.15; // dam wall centre (world X)
export const RES_DEPTH = 0.8; // reservoir depth (left of dam)
export const POOL_LEVEL = 0.1; // shallow pool surface height (right of dam)

const G = 3; // gravity (lower than 9.8 => calmer, easier to watch)
const EPS = 1e-3; // below this depth a cell counts as dry
const MAX_SPEED = 5; // safety clamp on flow speed

// Cell centre coordinate (same formula for X columns and Z rows)
export const cellPos = (i) => -SIZE / 2 + i * DX;

// Ground height: flat near the dam, then a gentle slope rising downstream
export const bedHeight = (x) => (x <= -0.95 ? 0 : 0.055 * (x + 0.95));

// The "Downstream Town": x/z = centre, w/d = footprint, h = wall height
export const BUILDINGS = [
	{ x: 1.5, z: -1.9, w: 0.8, d: 0.7, h: 0.55, wall: "#F4B8C5", roof: "#8FB8DE" },
	{ x: 2.4, z: -0.2, w: 0.7, d: 0.7, h: 0.7, wall: "#F8E2A0", roof: "#E58F8F" },
	{ x: 1.6, z: 1.7, w: 0.8, d: 0.8, h: 0.5, wall: "#B7E4C7", roof: "#F2A488" },
	{ x: 3.1, z: 1.6, w: 0.62, d: 0.62, h: 0.55, wall: "#CDB9F0", roof: "#F5D77A" },
];

export function createSolver() {
	const M = N * N;
	const h = new Float32Array(M);
	const hu = new Float32Array(M);
	const hv = new Float32Array(M);
	const b = new Float32Array(M);
	const solid = new Uint8Array(M);

	// Flux accumulators (summed over each cell's faces every step)
	const dh = new Float32Array(M);
	const dmx = new Float32Array(M);
	const dmz = new Float32Array(M);

	// Columns occupied by the dam wall (2 cells thick)
	const wallCols = [];
	for (let i = 0; i < N; i++)
		if (Math.abs(cellPos(i) - DAM_X) < 0.12) wallCols.push(i);

	/* ---------- Initial state ---------- */
	function reset() {
		h.fill(0);
		hu.fill(0);
		hv.fill(0);
		solid.fill(0);
		for (let j = 0; j < N; j++) {
			for (let i = 0; i < N; i++) {
				const id = j * N + i;
				const x = cellPos(i);
				const z = cellPos(j);
				b[id] = bedHeight(x);
				if (wallCols.includes(i)) solid[id] = 1;
				for (const bd of BUILDINGS)
					if (
						Math.abs(x - bd.x) <= bd.w / 2 &&
						Math.abs(z - bd.z) <= bd.d / 2
					)
						solid[id] = 1;
				if (!solid[id])
					h[id] =
						x < DAM_X ? RES_DEPTH : Math.max(0, POOL_LEVEL - b[id]);
			}
		}
	}

	/* ---------- Riemann flux across one face ----------
	   Works in the face's own frame: "un" = velocity through the face,
	   "ut" = velocity along it. Result goes into f:
	   f[0] mass, f[1] normal momentum, f[2] tangent momentum,
	   f[3]/f[4] normal momentum as seen by the left/right cell. */
	const f = new Float32Array(5);
	function riemann(hL, unL, utL, bL, hR, unR, utR, bR) {
		const zb = Math.max(bL, bR); // hydrostatic reconstruction
		const hsL = Math.max(0, hL + bL - zb);
		const hsR = Math.max(0, hR + bR - zb);
		const a = Math.max(
			Math.abs(unL) + Math.sqrt(G * hsL),
			Math.abs(unR) + Math.sqrt(G * hsR),
		); // fastest wave speed => numerical diffusion keeps it stable
		const qL = hsL * unL;
		const qR = hsR * unR;
		f[0] = 0.5 * (qL + qR) - 0.5 * a * (hsR - hsL);
		f[1] =
			0.5 *
				(qL * unL +
					0.5 * G * hsL * hsL +
					qR * unR +
					0.5 * G * hsR * hsR) -
			0.5 * a * (qR - qL);
		f[2] = 0.5 * (qL * utL + qR * utR) - 0.5 * a * (hsR * utR - hsL * utL);
		f[3] = f[1] + 0.5 * G * (hL * hL - hsL * hsL);
		f[4] = f[1] + 0.5 * G * (hR * hR - hsR * hsR);
	}

	const sL = [0, 0, 0, 0];
	const sR = [0, 0, 0, 0];
	// Read a cell into s = [depth, normal vel, tangent vel, bed]
	function load(id, dir, s) {
		const d = h[id];
		s[0] = d;
		s[3] = b[id];
		if (d > EPS) {
			const u = hu[id] / d;
			const v = hv[id] / d;
			s[1] = dir === 0 ? u : v;
			s[2] = dir === 0 ? v : u;
		} else {
			s[1] = 0;
			s[2] = 0;
		}
	}

	// Process the face between cell A (left/up-stream) and cell B (right).
	// An index of -1 means "outside the tank". dir 0 = X faces, 1 = Z faces.
	function addFace(A, B, dir) {
		const solA = A < 0 || solid[A] === 1;
		const solB = B < 0 || solid[B] === 1;
		if (solA && solB) return;
		if (solA) {
			load(B, dir, sR);
			sL[0] = sR[0];
			sL[1] = -sR[1];
			sL[2] = sR[2];
			sL[3] = sR[3]; // mirror wall
		} else {
			load(A, dir, sL);
			if (solB) {
				sR[0] = sL[0];
				sR[1] = -sL[1];
				sR[2] = sL[2];
				sR[3] = sL[3];
			} else load(B, dir, sR);
		}
		riemann(sL[0], sL[1], sL[2], sL[3], sR[0], sR[1], sR[2], sR[3]);
		const nA = dir === 0 ? dmx : dmz; // normal-momentum accumulator
		const tA = dir === 0 ? dmz : dmx; // tangent-momentum accumulator
		if (!solA) {
			dh[A] -= f[0];
			nA[A] -= f[3];
			tA[A] -= f[2];
		}
		if (!solB) {
			dh[B] += f[0];
			nA[B] += f[4];
			tA[B] += f[2];
		}
	}

	/* ---------- One time step ---------- */
	function step(dt) {
		dh.fill(0);
		dmx.fill(0);
		dmz.fill(0);
		for (let j = 0; j < N; j++)
			for (let i = -1; i < N; i++)
				addFace(
					i < 0 ? -1 : j * N + i,
					i + 1 >= N ? -1 : j * N + i + 1,
					0,
				);
		for (let i = 0; i < N; i++)
			for (let j = -1; j < N; j++)
				addFace(
					j < 0 ? -1 : j * N + i,
					j + 1 >= N ? -1 : (j + 1) * N + i,
					1,
				);

		const k = dt / DX;
		for (let id = 0; id < N * N; id++) {
			if (solid[id]) continue;
			let nh = h[id] + k * dh[id];
			let mx = hu[id] + k * dmx[id];
			let mz = hv[id] + k * dmz[id];
			if (nh < EPS) {
				h[id] = Math.max(nh, 0);
				hu[id] = 0;
				hv[id] = 0;
				continue;
			}
			const drag = 1 + dt * (0.3 + 0.02 / Math.max(nh, 0.02)); // soft friction
			mx /= drag;
			mz /= drag;
			const sp = Math.hypot(mx, mz) / nh;
			if (sp > MAX_SPEED) {
				mx *= MAX_SPEED / sp;
				mz *= MAX_SPEED / sp;
			}
			h[id] = nh;
			hu[id] = mx;
			hv[id] = mz;
		}
	}

	// Largest stable time step (CFL condition)
	function stableDt() {
		let s = 0.5;
		for (let id = 0; id < N * N; id++) {
			if (solid[id] || h[id] <= EPS) continue;
			s = Math.max(
				s,
				Math.hypot(hu[id], hv[id]) / h[id] + Math.sqrt(G * h[id]),
			);
		}
		return (0.4 * DX) / s;
	}

	// Advance by `dt` seconds using as many safe sub-steps as needed
	function advance(dt) {
		let rem = dt;
		for (let n = 0; n < 8 && rem > 1e-5; n++) {
			const s = Math.min(rem, stableDt());
			step(s);
			rem -= s;
		}
	}

	// Add a smooth water bump (a "drop") at world position (x, z)
	function addBump(x, z, amp = 0.2, radius = 0.28) {
		for (let j = 0; j < N; j++)
			for (let i = 0; i < N; i++) {
				const id = j * N + i;
				if (solid[id]) continue;
				const d2 = (cellPos(i) - x) ** 2 + (cellPos(j) - z) ** 2;
				h[id] += amp * Math.exp(-d2 / (2 * radius * radius));
			}
	}

	// Remove dam cells with |z| <= halfWidth. `rubble` = new ground height there.
	function openDam(halfWidth, rubble) {
		for (const i of wallCols)
			for (let j = 0; j < N; j++) {
				const id = j * N + i;
				if (solid[id] && Math.abs(cellPos(j)) <= halfWidth) {
					solid[id] = 0;
					b[id] = rubble;
					h[id] = 0;
					hu[id] = 0;
					hv[id] = 0;
				}
			}
	}

	reset();
	return { h, hu, hv, b, solid, reset, advance, addBump, openDam };
}
