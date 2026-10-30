"use client";

import styles from "@/components/docs/playgrounds/cookbook-media/cookbook-media.module.css";
import { colorOf, pieceLabel, squareName, typeOf, type Position } from "@/components/docs/playgrounds/cookbook-media/chess";

/** Solid glyphs for both sides, colored by CSS; U+FE0E keeps them text, not emoji. */
const GLYPH: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

/**
 * The on-page board for the voice chess demo: White at the bottom (the only orientation the recipe accepts), the
 * last move highlighted, a dry run's move previewed, and optionally every square labeled, like the recipe's
 * calibrated grid overlay. Each square names itself for screen readers.
 */
export function Chessboard({
  position,
  last,
  preview,
  labels = false,
}: {
  position: Position;
  last?: { from: number; to: number } | null;
  preview?: { from: number; to: number } | null;
  labels?: boolean;
}) {
  const squares: number[] = [];
  for (let rank = 7; rank >= 0; rank--) for (let file = 0; file < 8; file++) squares.push(rank * 8 + file);
  return (
    <div className={styles.boardWrap}>
      <div className={styles.ranks} aria-hidden="true">
        {[8, 7, 6, 5, 4, 3, 2, 1].map((r) => (
          <span key={r}>{r}</span>
        ))}
      </div>
      <div className={styles.board} role="group" aria-label={`Chessboard, White at the bottom, ${position.turn === "w" ? "White" : "Black"} to move`}>
        {squares.map((sq) => {
          const piece = position.board[sq];
          const lightSquare = ((sq >> 3) + (sq & 7)) % 2 === 1;
          const name = squareName(sq);
          return (
            <div
              key={sq}
              className={`${styles.square} ${lightSquare ? styles.light : styles.dark}`}
              data-last={last && (last.from === sq || last.to === sq) ? "true" : undefined}
              data-preview={preview && (preview.from === sq || preview.to === sq) ? "true" : undefined}
              role="img"
              aria-label={`${name}: ${piece ? pieceLabel(piece) : "empty"}`}
            >
              {labels ? <span className={styles.squareLabel}>{name}</span> : null}
              {piece ? (
                <span className={`${styles.piece} ${colorOf(piece) === "w" ? styles.pieceWhite : styles.pieceBlack}`} aria-hidden="true">
                  {GLYPH[typeOf(piece)]}
                  {"︎"}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className={styles.files} aria-hidden="true">
        {"abcdefgh".split("").map((f) => (
          <span key={f}>{f}</span>
        ))}
      </div>
    </div>
  );
}
