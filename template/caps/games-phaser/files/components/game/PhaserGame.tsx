"use client";

// A Phaser 4 game in a React page: a starting point. Phaser touches the window when it loads, so it is imported inside
// the effect, never at the top of the file, and destroyed when the component goes away. Replace the scene with the
// brief's game, and keep the parts that make it testable: a canvas that draws right away, keys and taps both working.
import { useEffect, useRef } from "react";
import type Phaser from "phaser";

export interface PhaserGameProps {
  /** Called with the score whenever it changes, for the page around the game to show. */
  onScore?(score: number): void;
}

export function PhaserGame({ onScore }: PhaserGameProps) {
  const host = useRef<HTMLDivElement>(null);
  const scoreRef = useRef(onScore);
  scoreRef.current = onScore;

  useEffect(() => {
    let game: Phaser.Game | null = null;
    let cancelled = false;
    void import("phaser").then(({ default: PhaserLib }) => {
      if (cancelled || !host.current) return;

      class Play extends PhaserLib.Scene {
        private player!: Phaser.GameObjects.Rectangle;
        private keys!: Phaser.Types.Input.Keyboard.CursorKeys;
        private steer = 0;
        private score = 0;

        constructor() {
          super("play");
        }

        create() {
          const { width, height } = this.scale;
          // Shapes drawn in code: no image files to load. Muse Image pictures or a 3D asset's preview can replace them.
          this.add.rectangle(width / 2, height - 24, width, 48, 0x0064e0);
          this.player = this.add.rectangle(width / 2, height - 72, 40, 40, 0xffffff).setStrokeStyle(4, 0x080809);
          this.keys = this.input.keyboard!.createCursorKeys();
          // Touch: hold the left or right half of the game to steer.
          this.input.on("pointerdown", (p: Phaser.Input.Pointer) => (this.steer = p.x < width / 2 ? -1 : 1));
          this.input.on("pointerup", () => (this.steer = 0));
        }

        update(_time: number, delta: number) {
          const dir = this.keys.left.isDown ? -1 : this.keys.right.isDown ? 1 : this.steer;
          if (!dir) return;
          const { width } = this.scale;
          this.player.x = PhaserLib.Math.Clamp(this.player.x + dir * 0.4 * delta, 20, width - 20);
          this.score += 1;
          scoreRef.current?.(this.score);
        }
      }

      game = new PhaserLib.Game({
        type: PhaserLib.AUTO,
        parent: host.current,
        width: 390,
        height: 520,
        backgroundColor: "#f0f2f5",
        scale: { mode: PhaserLib.Scale.FIT, autoCenter: PhaserLib.Scale.CENTER_HORIZONTALLY },
        scene: [Play],
        banner: false,
      });
    });
    return () => {
      cancelled = true;
      game?.destroy(true);
    };
  }, []);

  return <div ref={host} className="game-host" aria-label="Game. Use the arrow keys, or hold the left or right side to steer." role="application" />;
}
