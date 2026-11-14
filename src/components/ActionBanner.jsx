import {
	forwardRef,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createTimeline } from "animejs";

// One entry per action: colours/text come from the brief; `hold` = ms until the exit starts
const KINDS = {
	breach: {
		text: "CATASTROPHIC BREACH — SURGE WAVE INBOUND!",
		bg: "bg-valencia-300 text-cod-gray-950",
		dot: "bg-red-ribbon-600",
		hold: 2200,
	},
	sluice: {
		text: "SPILLWAY ACTIVE — CONTROLLED RELEASE",
		bg: "bg-fountain-blue-300 text-cod-gray-950",
		dot: "bg-cello-600",
		hold: 2200,
	},
	wave: {
		text: "WAVE PACKET INJECTED",
		bg: "bg-elephant-200 text-cod-gray-950",
		dot: "bg-fountain-blue-500",
		hold: 2200,
	},
	reset: {
		text: "RESERVOIR & DAM RESTORED",
		bg: "bg-pearl-bush-50 text-cod-gray-900",
		dot: "bg-gossamer-500",
		hold: 1500, // brief flash
	},
};

/* Comic event banner. Parent calls ref.current.show("breach" | "sluice" | "wave" | "reset").
   Only DOM nodes are animated (never the 3D canvas). A new show() cancels the running
   timeline first, so banners never overlap or get stuck. */
const ActionBanner = forwardRef(function ActionBanner(_, ref) {
	const [shown, setShown] = useState(null); // { id, kind }
	const idRef = useRef(0);
	const wrap = useRef(); // entrance / exit
	const card = useRef(); // attention pulse
	const dot = useRef();

	useImperativeHandle(
		ref,
		() => ({
			show(kind) {
				if (KINDS[kind]) setShown({ id: ++idRef.current, kind });
			},
		}),
		[],
	);

	useLayoutEffect(() => {
		if (!shown) return;
		const cfg = KINDS[shown.kind];
		const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		const tl = createTimeline();
		tl.add(wrap.current, {
			opacity: [0, 1],
			scaleX: [0.4, 1],
			scaleY: [1.7, 1],
			translateY: [-28, 0],
			duration: reduce ? 150 : 750,
			ease: reduce ? "linear" : "outElastic(1, .55)",
		});
		if (!reduce) {
			// subtle attention pulse while the banner is held
			tl.add(
				card.current,
				{ scale: [1, 1.045, 1], duration: 420, ease: "inOutSine", loop: 2 },
				520,
			);
			tl.add(
				dot.current,
				{ scale: [1, 1.7, 1], duration: 420, ease: "inOutSine", loop: 2 },
				520,
			);
		}
		tl.add(
			wrap.current,
			{
				opacity: [1, 0],
				translateY: [0, -14],
				scaleX: [1, 0.92],
				scaleY: [1, 0.92],
				duration: 350,
				ease: "inQuad",
			},
			cfg.hold,
		);
		// Cleanup runs before the next banner and on unmount (also under StrictMode)
		return () => tl.revert();
	}, [shown]);

	const cfg = shown ? KINDS[shown.kind] : KINDS.wave;
	return (
		<div className="pointer-events-none absolute inset-x-0 top-[4.25rem] z-10 flex justify-center px-3 md:top-5 md:px-0">
			<div ref={wrap} style={{ opacity: 0 }} aria-live="polite">
				<div
					ref={card}
					className={`flex items-center gap-2 rounded-xl border-2 border-cod-gray-900 px-3.5 py-2 shadow-[4px_4px_0_#191a19] md:gap-3 md:px-5 md:py-2.5 ${cfg.bg}`}
				>
					<span
						ref={dot}
						className={`h-3.5 w-3.5 shrink-0 rounded-sm border-2 border-cod-gray-900 ${cfg.dot}`}
					/>
					<span className="font-phenomena text-sm font-bold uppercase tracking-wide md:text-base">
						{cfg.text}
					</span>
				</div>
			</div>
		</div>
	);
});

export default ActionBanner;
