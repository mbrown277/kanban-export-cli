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
id,name,closed,due
5f2a1b3c9d8e7f0012345678,Write the RFC,false,
5f2a1b3c9d8e7f0012345679,Ship v1,false,2026-09-01T00:00:00.000Z
5f2a1b3c9d8e7f001234567a,Old idea nobody picked up,true,
```

To pull a different top-level array (say, to sanity-check the raw action
log) instead of cards:

```sh
node dist/cli.js my-board.json --array=actions > actions.csv
```

Right now only `cards` is mapped to real CSV columns (`id`, `name`,
`closed`, `due`); pointing `--array` at anything else will scan and parse
correctly but won't emit rows for elements that don't have string `id` and
`name` fields.

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
- List names aren't resolved yet — the CSV doesn't even include the raw
  `idList` reference, let alone a name joined against the `lists` array.
