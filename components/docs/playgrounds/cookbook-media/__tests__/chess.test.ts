/**
 * The voice chess demo's rules engine and move parser (cookbook/voice-chess-cua). The engine is checked with the
 * standard perft counts (start position, Kiwipete and positions 3 to 5), which catch castling, en passant, promotion
 * and pin bugs; the parser with the recipe's exact grammar, the demo's piece grammar, and every way a turn fails closed.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-media/__tests__/chess.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  START_FEN,
  applyMove,
  fromFen,
  gameStatus,
  legalMoves,
  parseSquare,
  perft,
  squareName,
  startPosition,
  toFen,
  toSan,
} from "@/components/docs/playgrounds/cookbook-media/chess";
import {
  cleanHeard,
  moveListText,
  newGame,
  parseUtterance,
  replyFor,
  resolveCommand,
  runTurn,
} from "@/components/docs/playgrounds/cookbook-media/chess-voice";

describe("chess engine", () => {
  it("reads and writes FEN", () => {
    assert.equal(toFen(startPosition()), START_FEN);
    const kiwi = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
    assert.equal(toFen(fromFen(kiwi)), kiwi);
    assert.throws(() => fromFen("8/8/8 w - - 0 1"));
  });

  it("names squares", () => {
    assert.equal(squareName(0), "a1");
    assert.equal(squareName(63), "h8");
    assert.equal(parseSquare("E4"), 28);
    assert.equal(parseSquare("i9"), null);
  });

  const PERFT: Array<[string, string, number[]]> = [
    ["start", START_FEN, [20, 400, 8902]],
    ["kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", [48, 2039, 97862]],
    ["position 3", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", [14, 191, 2812, 43238]],
    ["position 4", "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", [6, 264, 9467]],
    ["position 5", "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", [44, 1486, 62379]],
  ];
  for (const [name, fen, counts] of PERFT) {
    it(`matches perft for ${name}`, () => {
      const p = fromFen(fen);
      counts.forEach((n, i) => assert.equal(perft(p, i + 1), n, `depth ${i + 1}`));
    });
  }

  it("writes SAN with disambiguation, captures, castling, promotion and mate", () => {
    const amb = fromFen("rnbqkbnr/pppppppp/8/8/3P4/5N2/PPP1PPPP/RNBQKB1R w KQkq - 0 1");
    const nbd2 = legalMoves(amb).find((m) => squareName(m.from) === "b1" && squareName(m.to) === "d2")!;
    assert.equal(toSan(amb, nbd2), "Nbd2");
    let p = startPosition();
    for (const [from, to] of [["f2", "f3"], ["e7", "e5"], ["g2", "g4"]]) {
      p = applyMove(p, legalMoves(p).find((m) => squareName(m.from) === from && squareName(m.to) === to)!);
    }
    const mate = legalMoves(p).find((m) => squareName(m.to) === "h4" && m.piece === "q")!;
    assert.equal(toSan(p, mate), "Qh4#");
    assert.equal(gameStatus(applyMove(p, mate)), "checkmate");
    const promo = fromFen("8/4P3/8/8/8/8/k7/4K3 w - - 0 1");
    const q = legalMoves(promo).find((m) => m.promotion === "q")!;
    assert.equal(toSan(promo, q), "e8=Q");
  });
});

describe("voice move grammar", () => {
  it("cleans only the edges of what was heard", () => {
    assert.equal(cleanHeard(" Move E2 to E4.​"), "Move E2 to E4.");
  });

  it("takes the recipe's exact phrase, case-insensitively, with an optional period", () => {
    for (const ok of ["Move E2 to E4", "move e2 to e4.", "MOVE G1 TO F3"]) {
      const r = parseUtterance(ok, "exact");
      assert.ok(r.ok, ok);
    }
  });

  it("rejects everything else in exact mode and says why", () => {
    const cases: Array<[string, RegExp]> = [
      ["Move E2 to E4,", /Only a trailing period/],
      ["Move E 2 to E 4", /Spacing isn't repaired/],
      ["Move E two to E four", /Spoken ranks/],
      ["Please move E2 to E4", /isn't lifted out of surrounding words/],
      ["Pawn to e4", /exact phrase/],
      ["Move E2  to E4", /Spacing/],
    ];
    for (const [text, why] of cases) {
      const r = parseUtterance(text, "exact");
      assert.equal(r.ok, false, text);
      if (!r.ok) assert.match(r.rejection.message, why, text);
    }
    const same = parseUtterance("Move E2 to E2", "exact");
    assert.equal(same.ok, false);
    if (!same.ok) assert.equal(same.rejection.code, "same_square");
  });

  it("reads several piece moves in one turn, with or without punctuation", () => {
    for (const text of ["pawn to e4. knight to f3. bishop to c4. castle kingside.", " pawn to e4, knight to f3, bishop to c4, castle kingside,", "Pawn to e4 Knight to f3 Bishop to c4 Castle kingside"]) {
      const r = parseUtterance(text, "pieces");
      assert.ok(r.ok, text);
      if (r.ok) assert.deepEqual(r.commands.map((c) => c.kind), ["piece", "piece", "piece", "castle"]);
    }
  });

  it("rejects a turn with any word outside a move", () => {
    for (const [text, why] of [
      ["corn to e4, knight to f3", /"corn to e4" isn't a move\. "corn" isn't a piece/],
      ["Conte 4. Night F3.", /isn't a move/],
      ["knight to f three", /Spoken ranks/],
      [", pawn to e4", /starts with a move/],
      ["pawn to e-4", /isn't part of a move/],
      ["Move E 2 to E 4", /Spacing isn't repaired/],
    ] as const) {
      const r = parseUtterance(text, "pieces");
      assert.equal(r.ok, false, text);
      if (!r.ok) assert.match(r.rejection.message, why, text);
    }
  });
});

describe("voice turns on the board", () => {
  it("plays the sample's four White moves with Black's book replies", () => {
    const out = runTurn(newGame(startPosition()), "pawn to e4. knight to f3. bishop to c4. castle kingside.", { grammar: "pieces", autoReply: true });
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.deepEqual(out.played.map((p) => p.san), ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6"]);
    assert.deepEqual(out.played.map((p) => p.by), ["you", "reply", "you", "reply", "you", "reply", "you", "reply"]);
    assert.equal(moveListText(out.state.sans), "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6");
  });

  it("rejects the whole turn when a later move fails, leaving the board as it was", () => {
    const game = newGame(startPosition());
    const out = runTurn(game, "knight to f3 bishop to c4 castle kingside", { grammar: "pieces", autoReply: true });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.rejection.at, 1);
    assert.match(out.rejection.message, /No white bishop can move to c4/);
    assert.equal(toFen(game.position), START_FEN);
  });

  it("fails closed on an ambiguous piece and names the squares", () => {
    const p = fromFen("rnbqkbnr/pppppppp/8/8/3P4/5N2/PPP1PPPP/RNBQKB1R w KQkq - 0 1");
    const r = parseUtterance("knight to d2", "pieces");
    assert.ok(r.ok);
    if (!r.ok) return;
    const found = resolveCommand(p, r.commands[0]);
    assert.equal(found.ok, false);
    if (!found.ok) {
      assert.equal(found.rejection.code, "ambiguous");
      assert.match(found.rejection.message, /b1 and f3 can both move to d2\. Say "Move B1 to D2"/);
    }
    const exact = runTurn(newGame(p), "Move B1 to D2", { grammar: "exact", autoReply: false });
    assert.ok(exact.ok);
    if (exact.ok) assert.equal(exact.played[0].san, "Nbd2");
  });

  it("explains wrong side, illegal, empty squares and blocked castling", () => {
    const game = newGame(startPosition());
    const cases: Array<[string, string, RegExp]> = [
      ["Move E7 to E5", "wrong_side", /black pawn, and it's White's move/],
      ["Move E2 to E5", "illegal", /pawn on e2 can't move to e5/],
      ["Move E3 to E4", "no_piece", /no piece on e3/],
    ];
    for (const [text, code, why] of cases) {
      const out = runTurn(game, text, { grammar: "exact", autoReply: false });
      assert.equal(out.ok, false, text);
      if (!out.ok) {
        assert.equal(out.rejection.code, code, text);
        assert.match(out.rejection.message, why, text);
      }
    }
    const castle = runTurn(game, "castle kingside", { grammar: "pieces", autoReply: false });
    assert.equal(castle.ok, false);
    if (!castle.ok) assert.match(castle.rejection.message, /needs f1 and g1 empty; f1 and g1 are taken/);
  });

  it("alternates sides without the auto reply", () => {
    let game = newGame(startPosition());
    const first = runTurn(game, "Move E2 to E4", { grammar: "exact", autoReply: false });
    assert.ok(first.ok);
    if (first.ok) game = first.state;
    const second = runTurn(game, "Move E7 to E5", { grammar: "exact", autoReply: false });
    assert.ok(second.ok);
    if (second.ok) assert.equal(moveListText(second.state.sans), "1. e4 e5");
  });

  it("promotes to a queen and checks everything in a dry run without moving", () => {
    const game = newGame(fromFen("8/4P3/8/8/8/8/k7/4K3 w - - 0 1"));
    const dry = runTurn(game, "Move E7 to E8", { grammar: "exact", autoReply: false, dryRun: true });
    assert.ok(dry.ok);
    if (!dry.ok) return;
    assert.equal(dry.played[0].san, "e8=Q");
    assert.equal(dry.state, game);
  });

  it("answers from the book, then with the first legal move", () => {
    const p = startPosition();
    const e4 = legalMoves(p).find((m) => squareName(m.from) === "e2" && squareName(m.to) === "e4")!;
    const after = applyMove(p, e4);
    const reply = replyFor(after, [e4])!;
    assert.equal(`${squareName(reply.from)}${squareName(reply.to)}`, "e7e5");
    const h3 = legalMoves(p).find((m) => squareName(m.from) === "h2" && squareName(m.to) === "h3")!;
    const off = replyFor(applyMove(p, h3), [h3]);
    assert.ok(off);
  });
});

describe("real transcripts of the chess sample", () => {
  // What Muse Voice Transcribe returned for chess-moves.wav through the docs proxy (Oct 30, 2026), by keyword list.
  it("plays the file endpoint's ENDPOINTING turns one after another", () => {
    let game = newGame(startPosition());
    for (const turn of ["Pawn to e4", "Knight to f3", "Bishop to c4 Castle kingside"]) {
      const out = runTurn(game, turn, { grammar: "pieces", autoReply: true });
      assert.ok(out.ok, turn);
      if (out.ok) game = out.state;
    }
    assert.equal(moveListText(game.sans), "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6");
  });

  it("plays a realtime turn that holds all four moves", () => {
    const out = runTurn(newGame(startPosition()), "pawn to e4 knight to f3 bishop to c4 castle kingside", { grammar: "pieces", autoReply: true });
    assert.ok(out.ok);
  });

  it("fails closed on what it heard without good keywords", () => {
    for (const heard of ["corn to e4, knight to f3, bishop to c4", "corn to E four", "Conte 4. Night F3. Bishop to c4. Castle kingside.", "corn to e four knight to f three bishop to c four castle kingside"]) {
      const out = runTurn(newGame(startPosition()), heard, { grammar: "pieces", autoReply: true });
      assert.equal(out.ok, false, heard);
    }
    const blocked = runTurn(newGame(startPosition()), "castle kingside", { grammar: "pieces", autoReply: true });
    assert.equal(blocked.ok, false, "castling with the bishop and knight still home");
    const exact = runTurn(newGame(startPosition()), "Knight to F three.", { grammar: "exact", autoReply: true });
    assert.equal(exact.ok, false);
  });
});
