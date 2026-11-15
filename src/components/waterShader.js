import * as THREE from "three";

/* ============================================================
   Hokusai / vector-comic water (Batch 1)
   ------------------------------------------------------------
   Two ShaderMaterials share ONE geometry (the solver-driven grid):
     - water : flat cel-shaded bands + thin ink contour lines
     - foam  : its own overlay mesh (+FOAM_LIFT above the water, plus
               polygonOffset) with scalloped white caps, an ice-blue
               under-shadow band and an ink outline.
   Both run the same vertex code, so the ambient rolling waves
   (damped near obstacles) displace them identically.
   The solver arrays are only READ (see WaterTank.writeGeometry).
   ============================================================ */

export const FOAM_LIFT = 0.006;
const HALF = 4.0; // SIZE / 2 (tank half-width)

const hex = (h) => new THREE.Color(h);

export function createWaterMaterials() {
	// One uniforms object => both materials always stay in sync
	const uniforms = {
		uTime: { value: 0 },
		uHeat: { value: 0 }, // 1 = Hazard Heatmap on
		uAmb: { value: 1 }, // ambient wave strength
		uLift: { value: 0 },
		cMid: { value: hex("#2C9BA0") },
		cLight: { value: hex("#72D6D6") },
		cDeep: { value: hex("#397581") },
		cFoam: { value: hex("#F9FAFA") },
		cIce: { value: hex("#CAFAFF") },
		cInk: { value: hex("#191A19") },
		cSand: { value: hex("#E4D4C4") },
	};

	const vertex = /* glsl */ `
		attribute vec4 aData;   // x = depth, y = solver foam 0..1, z = obstacle damping 0..1
		uniform float uTime, uHeat, uAmb, uLift;
		varying vec2 vXZ;
		varying float vDepth, vFoam, vWave, vDamp, vY;
		varying vec3 vHeat, vN;

		// sharp-crested, broad-trough wave profile (Gerstner-like look), -1..1
		float crest(float ph) { float s = 0.5 + 0.5 * sin(ph); return s * s * 2.0 - 1.0; }
		// Coherent swells rolling toward +X: long, gently curved crest lines (no round bumps)
		float waveField(vec2 p, float t) {
			float x1 = p.x + 0.35 * sin(p.y * 0.9 + 0.6);
			float x2 = p.x * 0.97 + p.y * 0.24 + 0.25 * sin(p.y * 1.7 + 2.0);
			float s = crest(x1 * 2.5 - t * 1.2);
			s += 0.55 * crest(x2 * 3.9 - t * 1.6 + 1.9);
			return s / 1.55;
		}

		void main() {
			float edge = min(${HALF.toFixed(1)} - abs(position.x), ${HALF.toFixed(1)} - abs(position.z));
			float wet  = smoothstep(0.02, 0.14, aData.x);
			// ambient amplitude fades near tank walls, dam and buildings, and on dry ground
			float damp = aData.z * smoothstep(0.12, 0.7, edge) * wet * (1.0 - uHeat) * uAmb;
			float w = waveField(position.xz, uTime);

			vec3 p = position;
			p.y += w * 0.04 * damp + uLift;

			vXZ = position.xz;
			vDepth = aData.x;
			vWave = w;
			vDamp = damp;
			// foam is ONLY physical: solver surge/speed, shorelines and obstacle perimeters
			vFoam = aData.y;
			vY = position.y;
			vHeat = color;
			vN = normal;
			gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
		}
	`;

	const common = /* glsl */ `
		uniform float uTime, uHeat;
		uniform vec3 cMid, cLight, cDeep, cFoam, cIce, cInk, cSand;
		varying vec2 vXZ;
		varying float vDepth, vFoam, vWave, vDamp, vY;
		varying vec3 vHeat, vN;

		// crisp ~1.3px line where "v" crosses "level"
		float inkLine(float v, float level) {
			float px = abs(v - level) / max(fwidth(v), 1e-5);
			return 1.0 - smoothstep(0.55, 1.35, px);
		}
		// repeated crisp lines every 1/freq units of v (curved contours of v)
		float striation(float v, float freq) {
			float f = v * freq;
			float px = abs(fract(f + 0.5) - 0.5) / max(fwidth(f), 1e-5);
			return 1.0 - smoothstep(0.55, 1.35, px);
		}
		// world-space slope of a scalar field (zoom independent)
		float worldSlope(float v) {
			float wpx = length(vec2(fwidth(vXZ.x), fwidth(vXZ.y)));
			return fwidth(v) / max(wpx, 1e-6);
		}
		// --- organic foam breakup: warped 2-octave rotated value noise, advected downstream ---
		float hash21(vec2 p) {
			p = fract(p * vec2(123.34, 456.21));
			p += dot(p, p + 45.32);
			return fract(p.x * p.y);
		}
		float vnoise(vec2 p) {
			vec2 i = floor(p), f = fract(p);
			f = f * f * (3.0 - 2.0 * f);
			return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
			           mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
		}
		// scalloped (cusped) threshold used for the foam edge, 0..1
		float scallop() {
			vec2 p = vXZ - vec2(uTime * 0.45, 0.0);
			vec2 w = vec2(vnoise(p * 2.3 + 7.1), vnoise(p * 2.3 - 3.7)) - 0.5;
			p += w * 0.9; // domain warp: no straight rows or columns
			mat2 R = mat2(0.8, -0.6, 0.6, 0.8);
			float n = vnoise(R * p * 6.0) * 0.65 + vnoise(R * R * p * 13.0 + 11.0) * 0.35;
			return smoothstep(0.15, 0.85, n);
		}
	`;

	const waterFrag = /* glsl */ `
		${common}
		void main() {
			vec3 col;
			if (uHeat > 0.5) {
				col = vHeat; // Hazard Heatmap (cyan -> amber -> red), untouched
			} else {
				// flat 3-step cel bands: depth + rolling wave height
				float score = clamp(vDepth / 1.2, 0.0, 1.0) * 0.7 - vWave * 0.3 * clamp(vDamp * 1.5, 0.0, 1.0);
				float t1 = 0.30, t2 = 0.62;
				float fw = max(fwidth(score), 1e-5);
				float b1 = clamp((score - t1) / fw + 0.5, 0.0, 1.0);
				float b2 = clamp((score - t2) / fw + 0.5, 0.0, 1.0);
				vec3 water = mix(mix(cLight, cMid, b1), cDeep, b2);

				// dry ground = flat sand with a gentle 2-step shade
				// two-step terrain shade + faint contour lines (only on the sloped ground)
				float rise = step(0.02, vY);
				float terrace = mod(floor(vY / 0.06), 2.0);
				vec3 sand = cSand * (0.93 + 0.07 * step(0.97, normalize(vN).y)) * (1.0 - 0.04 * terrace * rise);
				sand = mix(sand, cInk, striation(vY, 1.0 / 0.06) * rise * 0.22);
				float m = vDepth - 0.02;
				float wetMask = clamp(m / max(fwidth(m), 1e-5) + 0.5, 0.0, 1.0);
				col = mix(sand, water, wetMask);

				// ice-blue highlight band hugging the light side of each band contour (Hokusai layering)
				float p1 = (score - t1) / fw;
				float p2 = (score - t2) / fw;
				float ice1 = clamp(p1 + 5.0, 0.0, 1.0) * clamp(-1.2 - p1 + 0.5, 0.0, 1.0);
				float ice2 = clamp(p2 + 5.0, 0.0, 1.0) * clamp(-1.2 - p2 + 0.5, 0.0, 1.0);
				col = mix(col, cIce, max(ice1, ice2) * wetMask * 0.95);

				// ink: band contours + sparse crest ridge lines (only on wet water)
				float ink = max(inkLine(score, t1), inkLine(score, t2));
				// curved flow striations along steep swell faces...
				float surf = vWave * 0.04 * vDamp;
				float steepW = smoothstep(0.07, 0.16, worldSlope(surf)) * smoothstep(0.3, 0.8, vDamp);
				ink = max(ink, striation(vWave, 1.6) * steepW * 0.85);
				// ...and along moving surge gradients (steep changes in water depth)
				float steepS = smoothstep(0.35, 0.9, worldSlope(vDepth));
				ink = max(ink, striation(vDepth, 9.0) * steepS * 0.9);
				col = mix(col, cInk, ink * wetMask * 0.9);
			}
			gl_FragColor = vec4(col, 1.0);
			#include <colorspace_fragment>
		}
	`;

	const foamFrag = /* glsl */ `
		${common}
		void main() {
			if (uHeat > 0.5) discard;
			float thr = 0.38 + 0.24 * scallop();
			float m  = vFoam - thr;          // >0 inside white foam
			float m2 = vFoam - (thr - 0.14); // >0 inside foam + ice shadow
			float px  = m  / max(fwidth(m),  1e-4);
			float px2 = m2 / max(fwidth(m2), 1e-4);
			if (px2 < 0.0) discard;
			vec3 col;
			if (px2 < 1.4)      col = cInk;                 // outline around the whole foam shape
			else if (px > 0.0)  col = cFoam;                // scalloped white cap
			else                col = cIce;                 // ice-blue under-shadow band
			gl_FragColor = vec4(col, 1.0);
			#include <colorspace_fragment>
		}
	`;

	const water = new THREE.ShaderMaterial({
		uniforms,
		vertexShader: vertex,
		fragmentShader: waterFrag,
		vertexColors: true,
		toneMapped: false,
	});

	const foam = new THREE.ShaderMaterial({
		uniforms,
		vertexShader: vertex,
		fragmentShader: foamFrag,
		vertexColors: true,
		toneMapped: false,
		polygonOffset: true,
		polygonOffsetFactor: -2,
		polygonOffsetUnits: -2,
	});
	foam.defines = {};
	// the foam mesh sits FOAM_LIFT above the water (same displacement + constant lift)
	foam.uniforms = { ...uniforms, uLift: { value: FOAM_LIFT } };

	return { water, foam, uniforms };
}
