import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import WaterTank from "./WaterTank";

export default function SceneSetup({ apiRef, wireframe, heat }) {
	return (
		<Canvas
			shadows // enable shadow maps
			orthographic // true isometric look: no perspective foreshortening
			camera={{
				position: [8, 8, 8], // equal x/y/z = classic isometric angle
				zoom: 64, // for orthographic cameras, "zoom" = pixels per world unit
				near: 0.1,
				far: 200,
			}}
			dpr={[1.5, 2]} // never below 1.5x: smoother edges and outlines
		>
			{/* Warm off-white studio background */}
			<color attach="background" args={["#F9F7F3"]} />

			{/* Soft warm fill light so shadows never go fully black */}
			<ambientLight intensity={0.6} color="#FFF1DC" />

			{/* Key light that casts the soft diorama shadow */}
			<directionalLight
				position={[6, 10, 4]}
				intensity={1.6}
				color="#FFF6E8"
				castShadow
				shadow-mapSize-width={2048}
				shadow-mapSize-height={2048}
				shadow-camera-left={-10}
				shadow-camera-right={10}
				shadow-camera-top={10}
				shadow-camera-bottom={-10}
				shadow-camera-near={0.5}
				shadow-camera-far={40}
				shadow-bias={-0.0005}
			/>

			{/* Floor: an invisible plane that only shows shadows, plus a subtle grid on top */}
			<mesh
				rotation={[-Math.PI / 2, 0, 0]}
				position={[0, -0.3, 0]}
				receiveShadow
			>
				<planeGeometry args={[60, 60]} />
				<shadowMaterial color="#84614A" opacity={0.24} />
			</mesh>
			<gridHelper
				args={[60, 60, "#E4DBCB", "#F1ECE3"]}
				position={[0, -0.29, 0]}
			/>

			{/* The diorama itself */}
			<WaterTank apiRef={apiRef} wireframe={wireframe} heat={heat} />

			{/* Smooth, bounded camera controls */}
			<OrbitControls
				makeDefault
				target={[0, -0.6, 0]}
				enableDamping
				dampingFactor={0.08}
				maxPolarAngle={Math.PI / 2.2} // can't orbit below the floor
				minPolarAngle={0.2} // can't flip over the top
				minZoom={20}
				maxZoom={110}
			/>
		</Canvas>
	);
}
