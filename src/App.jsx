import { useLayoutEffect, useRef, useState } from "react";
import { createTimeline, set, stagger } from "animejs";
import ActionBanner from "./components/ActionBanner";
import TelemetryDrawer from "./components/TelemetryDrawer";
import SceneSetup from "./components/SceneSetup";

// Architectural-comic UI: crisp corners, dark ink borders, hard offset shadows
const ink = "border-2 border-cod-gray-900";
const hard = "shadow-[3px_3px_0_#191a19]";
// Tactile micro-lift on hover, compression on press
const lift =
	"transition-all duration-150 ease-out hover:-translate-x-[1.5px] hover:-translate-y-[1.5px] hover:shadow-[4.5px_4.5px_0_#191a19] active:translate-x-[2px] active:translate-y-[2px] active:shadow-[1px_1px_0_#191a19]";
const btn = `group ${ink} ${hard} ${lift} flex min-h-[40px] touch-manipulation items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 font-phenomena text-sm font-bold tracking-wide md:justify-start md:gap-2 md:px-4 md:py-2 md:text-base`;

// Small status dot inside buttons: nudges + grows on hover
const Dot = ({ color }) => (
	<span
		aria-hidden
		className={`h-2.5 w-2.5 shrink-0 rounded-sm border border-cod-gray-900 transition-transform duration-150 ease-out group-hover:translate-x-0.5 group-hover:scale-125 ${color}`}
	/>
);

// Small reusable on/off switch
function Toggle({ label, checked, onChange }) {
	return (
		<label
			data-pop
			className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-lg border-2 border-cod-gray-900 bg-pearl-bush-100/70 px-2.5 py-1.5 font-phenomena text-sm font-bold tracking-wide text-cod-gray-900 md:justify-start md:rounded-none md:border-0 md:bg-transparent md:pl-2 md:pr-3 md:py-0 md:text-base"
		>
			<span>{label}</span>
			<button
				type="button"
				role="switch"
				aria-checked={checked}
				onClick={() => onChange(!checked)}
				className={`${ink} relative h-7 w-12 shrink-0 touch-manipulation rounded-lg transition-colors duration-150 ${checked ? "bg-fountain-blue-300" : "bg-pearl-bush-200"}`}
			>
				<span
					className={`${ink} absolute left-0.5 top-0.5 h-5 w-5 rounded-md bg-pearl-bush-50 transition-transform duration-150 ease-out ${checked ? "translate-x-5" : "translate-x-0"}`}
				/>
			</button>
		</label>
	);
}

export default function App() {
	// apiRef is filled by <WaterTank/> with { openGate, breach, dropWave, reset, getTelemetry }
	const apiRef = useRef(null);
	const [wireframe, setWireframe] = useState(false);
	const [heat, setHeat] = useState(false);
	const bannerRef = useRef(null);
	const titleRef = useRef(null);
	const pillRef = useRef(null);
	const telRef = useRef(null);
	const [telOpen, setTelOpen] = useState(false);

	// Comic HUD entrance: runs once on mount; cleanup fully restores styles (StrictMode safe)
	useLayoutEffect(() => {
		const title = titleRef.current;
		const pill = pillRef.current;
		const tel = telRef.current;
		const pops = Array.from(pill.querySelectorAll("[data-pop]"));
		// everything with a CSS hover/transition: switch it off while anime drives inline values,
		// and give it back afterwards so the hover lift works right after load
		const fx = [...pops, tel];
		const restore = () =>
			fx.forEach((el) => {
				el.style.transition = "";
				el.style.transform = "";
			});
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
			return;
		fx.forEach((el) => (el.style.transition = "none"));
		set(pops, { opacity: 0, scale: 0.88 });
		set(pill, { opacity: 0 }); // starts 150ms into the timeline: hide it from frame one
		set(tel, { opacity: 0 });
		const tl = createTimeline({ onComplete: restore });
		tl.add(title, {
			translateY: [-24, 0],
			opacity: [0, 1],
			duration: 800,
			ease: "outElastic(1, .6)",
		})
			.add(
				pill,
				{
					translateY: [32, 0],
					opacity: [0, 1],
					duration: 800,
					ease: "outElastic(1, .7)",
				},
				150,
			)
			.add(
				tel,
				{
					translateY: [-24, 0],
					opacity: [0, 1],
					duration: 800,
					ease: "outElastic(1, .6)",
				},
				260,
			)
			.add(
				pops,
				{
					scale: [0.88, 1],
					opacity: [0, 1],
					duration: 380,
					ease: "outBack(2.4)",
					delay: stagger(45),
				},
				520,
			);
		return () => {
			tl.revert();
			[title, pill].forEach((el) => {
				el.style.opacity = "";
				el.style.transform = "";
			});
			restore();
			fx.forEach((el) => (el.style.opacity = ""));
		};
	}, []);

	// Run the existing apiRef call, then show the matching comic banner
	const banner = (kind) => bannerRef.current?.show(kind);

	return (
		<div className="relative h-full w-full">
			{/* 3D scene fills the whole screen */}
			<SceneSetup apiRef={apiRef} wireframe={wireframe} heat={heat} />

			{/* Comic event banner (pointer-events-none: never blocks orbit/click) */}
			<ActionBanner ref={bannerRef} />

			{/* Collapsible telemetry + AI drawer (polls getTelemetry only while open) */}
			<TelemetryDrawer apiRef={apiRef} open={telOpen} />

			{/* HUD layer: pointer-events-none lets mouse drags pass through to the 3D canvas */}
			<div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:p-5">
				{/* Top row: title card (left) + Telemetry & AI toggle (right) */}
				<div className="flex items-start justify-between gap-2">
					<div
						ref={titleRef}
						className={`${ink} pointer-events-auto w-fit rounded-xl bg-pearl-bush-50 px-3.5 py-2 shadow-[4px_4px_0_#191a19] md:px-5 md:py-3`}
					>
						<h1 className="font-galhaudisplay-bold text-xl leading-none tracking-tight text-cod-gray-900 md:text-2xl">
							ConserveFlow
						</h1>
						<p className="mt-1 font-phenomena text-[11px] font-bold uppercase leading-tight tracking-wider text-wedgewood-600 md:text-xs">
							Isometric Dam &amp; Flood Diorama
						</p>
					</div>
					<button
						ref={telRef}
						type="button"
						aria-expanded={telOpen}
						onClick={() => setTelOpen((o) => !o)}
						className={`group ${ink} ${hard} ${lift} pointer-events-auto flex shrink-0 touch-manipulation items-center gap-2 rounded-lg px-3 py-2 font-phenomena text-sm font-bold tracking-wide text-cod-gray-900 md:px-4 md:py-2 md:text-base ${telOpen ? "bg-lightning-yellow-200" : "bg-pearl-bush-50 hover:bg-lightning-yellow-100"}`}
					>
						<span className="relative flex h-2.5 w-2.5 transition-transform duration-150 group-hover:scale-125">
							<span className="absolute inline-flex h-full w-full animate-ping rounded-sm bg-gossamer-400 opacity-75" />
							<span className="relative inline-flex h-2.5 w-2.5 rounded-sm border border-cod-gray-900 bg-gossamer-500" />
						</span>
						<span className="sm:hidden">Telemetry</span>
						<span className="hidden sm:inline">
							Telemetry &amp; AI
						</span>
						<span
							aria-hidden
							className={`inline-block text-lg leading-none transition-transform duration-150 ease-out group-hover:-translate-x-0.5 ${telOpen ? "rotate-180" : ""}`}
						>
							‹
						</span>
					</button>
				</div>

				{/* Bottom-center control dock */}
				<div className="flex justify-center">
					<div
						ref={pillRef}
						className={`${ink} pointer-events-auto grid w-full max-w-md grid-cols-2 gap-1.5 rounded-xl bg-pearl-bush-50 p-2 shadow-[4px_4px_0_#191a19] md:flex md:w-auto md:max-w-none md:flex-wrap md:items-center md:justify-center md:gap-2.5 md:px-3 md:py-2.5`}
					>
						<button
							onClick={() => {
								apiRef.current?.openGate();
								banner("sluice");
							}}
							data-pop
							className={`${btn} bg-fountain-blue-300 text-cod-gray-950 hover:bg-fountain-blue-200`}
						>
							<Dot color="bg-cello-600" />
							Open Sluice Gate
						</button>
						<button
							onClick={() => {
								apiRef.current?.breach();
								banner("breach");
							}}
							data-pop
							className={`${btn} bg-valencia-300 text-cod-gray-950 hover:bg-valencia-200`}
						>
							<Dot color="bg-red-ribbon-600" />
							Catastrophic Breach
						</button>
						<button
							onClick={() => {
								apiRef.current?.dropWave();
								banner("wave");
							}}
							data-pop
							className={`${btn} bg-neptune-200 text-cod-gray-950 hover:bg-neptune-100`}
						>
							<Dot color="bg-elephant-500" />
							Drop Wave
						</button>
						<button
							onClick={() => {
								apiRef.current?.reset();
								banner("reset");
							}}
							data-pop
							className={`${btn} bg-white-linen-100 text-cod-gray-900 hover:bg-pearl-bush-200`}
						>
							<Dot color="bg-gossamer-500" />
							Reset Dam
						</button>
						<Toggle
							label="Hazard Heatmap"
							checked={heat}
							onChange={setHeat}
						/>
						<Toggle
							label="64×64 Wireframe"
							checked={wireframe}
							onChange={setWireframe}
						/>
					</div>
				</div>
			</div>
		</div>
	);
}
