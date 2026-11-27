# makefun-png-squeeze

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/affan511/makefun-png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/affan511/makefun-png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

A lossless PNG re-encoder for make.fun's "Squeeze screenshots into the
smallest PNG" bounty (png-squeeze-01-run-20261127). It rewrites each
1280x720 screenshot as a smaller PNG with every pixel byte-identical.

## How it works

`main.ts` (Node 22, no dependencies, pure built-ins) reads each instance
under `/input/<id>/image.png` and writes `/output/<id>/image.png`:

- Colour-type reduction: palette (type 3, transparent entries first,
  by count or by luminance) when the image holds at most 256 colours,
  grey (type 0) or grey+alpha (type 4) when every pixel is grey, RGB
  (type 2) or RGBA (type 6) otherwise, with a tRNS key when a single
  fully-transparent value can stand in for the alpha channel.
- Per-row filter choice: fixed filters (None/Sub/Up/Paeth), the
  minimum-sum heuristic, the fewest-distinct-pairs heuristic, and
  brute force (each of the five filters weighed by a real deflate of
  the row against the previous 32 KiB) — the winner picked by a
  level-1 deflate of the whole image, then re-deflated at level 9 /
  memLevel 9 with the best of the default and filtered strategies.
- Only the chunks the checker reads (IHDR, PLTE, tRNS, IDAT, IEND),
  bit depth 8, never interlaced.

## Run it

From the unpacked kit directory, on the practice set:

```
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node entry/main.ts
```

The grader runs `node /bot/main.ts` with `/input` and `/output` mounted.

## Measured on the practice set (kit scorer)

- Score **690,757 / 1,000,000** (8/8 answered, all exact), vs the
  house baseline fixed-paeth's **420,399** and the scale compressor's
  666,667 on the same set.
- Runtime ~13 s for the whole set locally (limit 60 s); two runs
  produce byte-identical output (no clock, randomness, or
  environment reads).

## Limits

The deflate is Node's zlib at level 9, not a zopfli-style optimal
parser, so on images where the house reference compressor's
optimal-parsing deflate shines this entry lands a little behind it
(the kit says the reference earns about 760–790 on these
screenshots). The margin over the house baseline is large on the
practice set, but the scored set is a fresh draw, so the rank on
the final board is not guaranteed.
