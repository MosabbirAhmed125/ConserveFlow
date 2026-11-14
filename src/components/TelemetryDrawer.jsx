import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createTimeline, set, stagger } from "animejs";

const card = "rounded-lg border-2 border-cod-gray-900 bg-pearl-bush-50 px-3 py-2.5";
const badge =
	"rounded-md border-2 border-cod-gray-900 px-2 py-0.5 font-phenomena text-xs font-bold uppercase tracking-wide text-cod-gray-950";

// Chunky comic progress bar
function Bar({ value, max, color }) {
	const pct = Math.max(0, Math.min(1, value / max)) * 100;
	return (
		<div className="mt-1.5 h-3 overflow-hidden rounded-md border-2 border-cod-gray-900 bg-pearl-bush-200">
			<div
				className={`h-full ${color}`}
				style={{ width: `${pct}%`, transition: "width 150ms linear" }}
			/>
		</div>
	);
}

/* Collapsible telemetry + AI drawer. Reads apiRef.current.getTelemetry() (read-only) every
   150ms ONLY while open, so React never re-renders at 60Hz. Wrapper is pointer-events-none:
   only the card itself takes the mouse. */
export default function TelemetryDrawer({ apiRef, open }) {
	const [mounted, setMounted] = useState(open);
	const [t, setT] = useState(null);
	const panel = useRef();

	if (open && !mounted) setMounted(true); // mount first, animate in on the next layout effect

	// Slide / pop in, or slide out then unmount
	useLayoutEffect(() => {
		const el = panel.current;
		if (!mounted || !el) return;
		const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		const metrics = Array.from(el.querySelectorAll("[data-metric]"));
		if (!open) {
			// reduced motion: same path, but a near-instant fade (setMounted runs in the callback)
			const out = createTimeline({ onComplete: () => setMounted(false) });
			out.add(el, {
				translateX: [0, reduce ? 0 : 28],
				opacity: [1, 0],
				duration: reduce ? 1 : 240,
				ease: "inQuad",
			});
			return () => out.revert();
		}
		if (reduce) return;
		set(el, { opacity: 0 });
		set(metrics, { opacity: 0 });
		const tl = createTimeline();
		tl.add(el, {
			translateX: [36, 0],
			opacity: [0, 1],
			scale: [0.96, 1],
			duration: 700,
			ease: "outElastic(1, .75)",
		}).add(
			metrics,
			{
				translateX: [18, 0],
				opacity: [0, 1],
				duration: 380,
				ease: "outBack(1.8)",
				delay: stagger(45),
			},
			120,
		);
		return () => {
			tl.revert();
			el.style.opacity = "";
			el.style.transform = "";
			metrics.forEach((m) => {
				m.style.opacity = "";
				m.style.transform = "";
			});
		};
	}, [open, mounted]);

	// Poll only while open
	useEffect(() => {
		if (!open) return;
		const tick = () => setT(apiRef.current?.getTelemetry?.() ?? null);
		const first = setTimeout(tick, 0);
		const id = setInterval(tick, 150);
		return () => {
			clearTimeout(first);
			clearInterval(id);
		};
	}, [open, apiRef]);

	if (!mounted) return null;

	const drift = t?.massDriftPct ?? 0;
	const conserved = Math.abs(drift) < 0.05;
	const f2 = (v) => (v ?? 0).toFixed(2);

	return (
		<div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
			<div
				ref={panel}
				className="pointer-events-auto absolute right-5 top-20 flex w-72 flex-col gap-2.5 rounded-xl border-2 border-cod-gray-900 bg-neptune-100 p-3 shadow-[4px_4px_0_#191a19]"
			>
				{/* 1. Compute engine */}
				<div data-metric className={card}>
					<p className="font-phenomena text-sm font-bold uppercase tracking-wider text-cod-gray-600">
						Compute Engine
					</p>
					<p className="font-phenomena text-base font-bold leading-tight tracking-wide text-cod-gray-900">
						2D SWE Finite-Volume (Rusanov • 64×64)
					</p>
					<span className={`${badge} mt-1.5 inline-block bg-wedgewood-200`}>
						ONNX Neural Operator • FastAPI Ready
					</span>
				</div>

				{/* 2. Mass conservation */}
				<div data-metric className={card}>
					<div className="flex items-center justify-between">
						<p className="font-phenomena text-sm font-bold uppercase tracking-wider text-cod-gray-600">
							Mass Conservation ΔV%
						</p>
						<span
							className={`${badge} ${conserved ? "bg-gossamer-300" : drift > 0 ? "bg-elephant-200" : "bg-lightning-yellow-300"}`}
						>
							{conserved ? "Conserved" : drift > 0 ? "Wave Injected" : "Drift"}
						</span>
					</div>
					<p className="font-['JetBrains_Mono'] text-2xl font-bold tabular-nums text-cod-gray-900">
						{drift >= 0 ? "+" : ""}
						{f2(drift)}%
					</p>
				</div>

				{/* 3. Peak surge depth */}
				<div data-metric className={card}>
					<div className="flex items-baseline justify-between">
						<p className="font-phenomena text-sm font-bold uppercase tracking-wider text-cod-gray-600">
							Peak Surge Depth h<sub>max</sub>
						</p>
						<p className="font-['JetBrains_Mono'] text-sm font-bold tabular-nums text-cod-gray-900">
							{f2(t?.maxDownstreamDepth)} m
						</p>
					</div>
					<Bar value={t?.maxDownstreamDepth ?? 0} max={0.8} color="bg-fountain-blue-400" />
				</div>

				{/* 4. Peak flow velocity */}
				<div data-metric className={card}>
					<div className="flex items-baseline justify-between">
						<p className="font-phenomena text-sm font-bold uppercase tracking-wider text-cod-gray-600">
							Peak Flow Velocity |u|<sub>max</sub>
						</p>
						<p className="font-['JetBrains_Mono'] text-sm font-bold tabular-nums text-cod-gray-900">
							{f2(t?.peakVelocity)} u/s
						</p>
					</div>
					<Bar value={t?.peakVelocity ?? 0} max={5} color="bg-valencia-400" />
				</div>

				{/* 5. Inundation + latency */}
				<div data-metric className={`${card} grid grid-cols-2 gap-3`}>
					<div>
						<p className="font-phenomena text-sm font-bold uppercase tracking-wider text-cod-gray-600">
							Valley Wet
						</p>
						<p className="font-['JetBrains_Mono'] text-lg font-bold tabular-nums text-cod-gray-900">
							{(t?.wetCoveragePct ?? 0).toFixed(1)}%
						</p>
					</div>
					<div>
						<p className="font-phenomena text-sm font-bold uppercase tracking-wider text-cod-gray-600">
							Step Latency
						</p>
						<p className="font-['JetBrains_Mono'] text-lg font-bold tabular-nums text-cod-gray-900">
							{f2(t?.stepMs)} ms
						</p>
					</div>
				</div>
			</div>
		</div>
	);
}
