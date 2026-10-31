"use client";

import { Container, Text } from "@react-three/uikit";
import type { ReactNode } from "react";
import { useXRTarget } from "@/lib/xr/targets";

// A flat panel in the Meta look: white, radius 16, Inter, Meta blue buttons. Sizes below are in panel pixels, and 1000 of
// them make a metre, because of pixelSize. Without pixelSize a 0.8 m panel would be 80 pixels wide and its text would wrap
// one word a line.
const PIXEL_SIZE = 0.001;
const BLUE = "#0064e0";
const INK = "#1c2b33";
const MUTED = "#65676b";

export interface PanelProps {
  /** Where its center is, in metres. Keep panels 1.2 to 1.5 m from the person. */
  position?: [number, number, number];
  /** Radians. Turn a panel off to one side to face the person. */
  rotation?: [number, number, number];
  /** Metres. */
  width?: number;
  height?: number;
  children: ReactNode;
}

export function Panel({ position = [0, 1.5, -1.4], rotation = [0, 0, 0], width = 0.8, height = 0.5, children }: PanelProps) {
  return (
    <group position={position} rotation={rotation}>
      <Container
        pixelSize={PIXEL_SIZE}
        sizeX={width}
        sizeY={height}
        backgroundColor="#ffffff"
        borderRadius={16}
        padding={32}
        gap={20}
        flexDirection="column"
        alignItems="stretch"
        justifyContent="center"
      >
        {children}
      </Container>
    </group>
  );
}

export function PanelTitle({ children }: { children: string }) {
  return (
    <Text fontSize={44} fontWeight={700} color={INK} textAlign="center">
      {children}
    </Text>
  );
}

export function PanelText({ children, muted = false }: { children: string; muted?: boolean }) {
  return (
    <Text fontSize={30} color={muted ? MUTED : INK} textAlign="center">
      {children}
    </Text>
  );
}

/** A model's answer: the only place the blue-to-violet accent appears. */
export function PanelResult({ children }: { children: string }) {
  return (
    <Container borderWidth={4} borderColor="#a033ff" borderRadius={16} padding={24}>
      <Text fontSize={30} color={INK}>
        {children}
      </Text>
    </Container>
  );
}

/** A button 60 panel pixels tall or more, big enough to hit with a controller ray or a finger. `name` is its name for tests. */
export function PanelButton({ name, children, onClick, secondary = false }: { name: string; children: string; onClick: () => void; secondary?: boolean }) {
  const ref = useXRTarget(name);
  return (
    <Container
      ref={ref}
      minHeight={72}
      paddingX={32}
      backgroundColor={secondary ? "#e4e6eb" : BLUE}
      hover={{ backgroundColor: secondary ? "#d8dadf" : "#0052b8" }}
      borderRadius={12}
      alignItems="center"
      justifyContent="center"
      onClick={onClick}
    >
      <Text fontSize={32} fontWeight={600} color={secondary ? INK : "#ffffff"}>
        {children}
      </Text>
    </Container>
  );
}
