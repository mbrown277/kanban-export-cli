# kanban-export-cli

Trello's "export board as JSON" gives you one file with the board's lists,
cards, and a complete action log — every comment, every card move, every
checklist tick, going back to the day the board was created. On a board
that's been alive for a few years that action log routinely dwarfs the parts
you actually wanted (the cards). I've hit exports well over a hundred
megabytes where `JSON.parse(fs.readFileSync(path))` sat there for a long
time doing work I didn't need, just to read a card list.

This tool reads the export as a stream and pulls out one named top-level
array (`cards` by default) as CSV, without ever holding the whole file, or
even the whole target array, in memory. It parses one array element at a
time and discards the rest of the document as it goes, so it doesn't care
whether the `actions` array next to `cards` has 200 entries or 2 million.

## Usage

```sh
node dist/cli.js my-board.json > cards.csv
```

```csv
id,name,list,closed,due,moves,lastMovedAt
5f2a1b3c9d8e7f0012345678,Write the RFC,Doing,false,,2,2026-08-20T14:03:11.000Z
5f2a1b3c9d8e7f0012345679,Ship v1,Done,false,2026-09-01T00:00:00.000Z,4,2026-09-01T09:12:45.000Z
5f2a1b3c9d8e7f001234567a,Old idea nobody picked up,Backlog,true,,0,
```

The `list` column is the resolved list name, not the raw `idList` reference
Trello puts on each card. Cross-referencing it against the `lists` array
means reading the export file a second time before streaming `cards` — the
`lists` array itself is small even on old boards, so it's read fully into
memory, but `cards` is still streamed one element at a time as before. If a
card's `idList` doesn't match any list in the export (a list that's since
been deleted, say), the raw id is used instead so the row still round-trips.

The `moves` and `lastMovedAt` columns come from the `actions` array — every
time a card's list changes, Trello records an `updateCard` action with an
`old.idList` field. `moves` is how many such actions exist for that card,
and `lastMovedAt` is the timestamp of the most recent one; a card that's
never changed lists gets `0` and an empty timestamp. This is a third
streamed pass over the file (after `lists` and before `cards`), but it only
keeps a count and a timestamp per card, not the actions themselves, so
memory use stays proportional to the number of cards rather than the number
of actions — even though `actions` is typically the largest array in the
export by far.

To pull a different top-level array (say, to sanity-check the raw action
log) instead of cards:

```sh
node dist/cli.js my-board.json --array=actions > actions.csv
```

To pick which columns come out, and in what order, use `--fields` with a
comma-separated list drawn from `id`, `name`, `list`, `closed`, `due`,
`moves`, `lastMovedAt`:

```sh
node dist/cli.js my-board.json --fields=id,name,due > cards-due.csv
```

Leaving out `list`, `moves`, or `lastMovedAt` skips the streamed pass that
would have computed it, so `--fields=id,name` runs faster than the default
since it never reads `lists` or `actions` at all.

Right now only `cards` is mapped to real CSV columns (`id`, `name`, `list`,
`closed`, `due`, `moves`, `lastMovedAt`); pointing `--array` at anything else
will scan and parse correctly but won't emit rows for elements that don't
have string `id` and `name` fields, and the `list`, `moves`, and
`lastMovedAt` columns will be blank/zero since list resolution and move
history only run when `--array` is `cards` (the default).

## How it avoids loading the whole file

`src/jsonArrayScanner.ts` is a small character-by-character state machine.
It tracks JSON nesting depth and string/escape state across the whole
document, watches for a top-level key whose name and following `:` match
the field you asked for, and once it finds that field's array, buffers only
one element at a time. As soon as an element's closing bracket is seen, that
element is parsed on its own (a small, bounded `JSON.parse` call) and handed
back to the caller. Once the array's own closing bracket is seen, scanning
stops entirely — if `cards` appears before `actions` in the file, the tool
never even reads the action log off disk.

The CLI wires this into `fs.createReadStream` and writes CSV rows straight
to stdout, respecting backpressure, so memory use stays roughly constant
regardless of how large the export file is.

## Building

No dependencies to install. Compile with any TypeScript compiler you
already have on your machine:

```sh
tsc
node dist/cli.js my-board.json > cards.csv
```

## Limitations

- Array elements that aren't objects or arrays (bare strings, numbers,
  booleans) are skipped rather than emitted.
- Only `cards` has a real CSV mapping today.
- Move history only counts list changes (`updateCard` actions with an
  `old.idList`); it doesn't record which lists a card passed through, only
  how many times it moved and when it last did.
