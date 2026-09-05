#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { JsonArrayScanner } from './jsonArrayScanner.js';
import { csvRow } from './csv.js';

const ALL_FIELDS = ['id', 'name', 'list', 'closed', 'due', 'moves', 'lastMovedAt'] as const;
type FieldName = (typeof ALL_FIELDS)[number];

function isFieldName(value: string): value is FieldName {
  return (ALL_FIELDS as readonly string[]).includes(value);
}

interface CliOptions {
  inputPath: string;
  arrayField: string;
  fields: FieldName[];
}

function parseArgs(argv: string[]): CliOptions {
  const positional: string[] = [];
  let arrayField = 'cards';
  let fields: FieldName[] = [...ALL_FIELDS];

  for (const arg of argv) {
    if (arg.startsWith('--array=')) {
      arrayField = arg.slice('--array='.length);
    } else if (arg.startsWith('--fields=')) {
      const requested = arg
        .slice('--fields='.length)
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      if (requested.length === 0) {
        throw new Error('--fields requires at least one field name');
      }
      for (const name of requested) {
        if (!isFieldName(name)) {
          throw new Error(`unknown field "${name}"; valid fields are: ${ALL_FIELDS.join(', ')}`);
        }
      }
      fields = requested as FieldName[];
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    throw new Error(
      'usage: kanban-export-cli <trello-export.json> [--array=cards] [--fields=id,name,...]'
    );
  }

  return { inputPath: positional[0], arrayField, fields };
}

interface TrelloCard {
  id: string;
  name: string;
  closed: boolean;
  due: string | null;
  idList?: string;
}

function isTrelloCard(value: unknown): value is TrelloCard {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    (record.idList === undefined || typeof record.idList === 'string')
  );
}

interface TrelloList {
  id: string;
  name: string;
}

function isTrelloList(value: unknown): value is TrelloList {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.name === 'string';
}

// A board's "lists" array is a handful to a few dozen entries even on old
// boards, unlike "cards" or "actions", so buffering it fully in memory is
// fine. Reading the file a second time to do it is cheaper than the
// alternative of teaching the scanner to track two arrays at once, and
// still avoids ever holding "cards" or "actions" in memory.
async function loadListNames(inputPath: string): Promise<Map<string, string>> {
  const scanner = new JsonArrayScanner('lists');
  const input = createReadStream(inputPath, { encoding: 'utf8' });
  const listNames = new Map<string, string>();

  for await (const chunk of input) {
    for (const element of scanner.feed(chunk)) {
      if (isTrelloList(element)) listNames.set(element.id, element.name);
    }
    if (scanner.done) {
      input.destroy();
      break;
    }
  }

  return listNames;
}

interface TrelloAction {
  type: string;
  date?: string;
  data?: {
    card?: { id?: string };
    old?: { idList?: string };
  };
}

function isCardMoveAction(value: unknown): value is TrelloAction & {
  date: string;
  data: { card: { id: string }; old: { idList: string } };
} {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== 'updateCard' || typeof record.date !== 'string') return false;
  const data = record.data as Record<string, unknown> | undefined;
  if (typeof data !== 'object' || data === null) return false;
  const card = data.card as Record<string, unknown> | undefined;
  const old = data.old as Record<string, unknown> | undefined;
  return (
    typeof card === 'object' &&
    card !== null &&
    typeof card.id === 'string' &&
    typeof old === 'object' &&
    old !== null &&
    typeof old.idList === 'string'
  );
}

interface CardMoveHistory {
  moves: number;
  lastMovedAt: string;
}

// Every list change a card ever went through is recorded as an "updateCard"
// action with an "old.idList", so the "actions" array (which dwarfs "cards"
// on any board with real history) is the only source for this. Streaming it
// and keeping only a per-card count and latest timestamp means memory use
// stays proportional to the number of distinct cards, not the number of
// actions, which is the same trade the "cards" export itself makes.
async function loadCardMoveHistory(inputPath: string): Promise<Map<string, CardMoveHistory>> {
  const scanner = new JsonArrayScanner('actions');
  const input = createReadStream(inputPath, { encoding: 'utf8' });
  const history = new Map<string, CardMoveHistory>();

  for await (const chunk of input) {
    for (const element of scanner.feed(chunk)) {
      if (!isCardMoveAction(element)) continue;
      const cardId = element.data.card.id;
      const existing = history.get(cardId);
      if (existing === undefined) {
        history.set(cardId, { moves: 1, lastMovedAt: element.date });
      } else {
        existing.moves++;
        if (element.date > existing.lastMovedAt) existing.lastMovedAt = element.date;
      }
    }
    if (scanner.done) {
      input.destroy();
      break;
    }
  }

  return history;
}

function fieldValue(
  fieldName: FieldName,
  element: TrelloCard,
  list: string,
  moves: CardMoveHistory | undefined
): string {
  switch (fieldName) {
    case 'id':
      return element.id;
    case 'name':
      return element.name;
    case 'list':
      return list;
    case 'closed':
      return String(element.closed);
    case 'due':
      return element.due ?? '';
    case 'moves':
      return String(moves?.moves ?? 0);
    case 'lastMovedAt':
      return moves?.lastMovedAt ?? '';
  }
}

async function main(): Promise<void> {
  const { inputPath, arrayField, fields } = parseArgs(process.argv.slice(2));
  // Skip the extra streamed passes entirely when the requested fields don't
  // need them, rather than doing the work and throwing away the result.
  const needsListNames = arrayField === 'cards' && fields.includes('list');
  const needsMoveHistory =
    arrayField === 'cards' && (fields.includes('moves') || fields.includes('lastMovedAt'));
  const listNames = needsListNames ? await loadListNames(inputPath) : new Map<string, string>();
  const moveHistory = needsMoveHistory ? await loadCardMoveHistory(inputPath) : new Map<string, CardMoveHistory>();
  const scanner = new JsonArrayScanner(arrayField);
  const input = createReadStream(inputPath, { encoding: 'utf8' });

  process.stdout.write(csvRow(fields));

  for await (const chunk of input) {
    const elements = scanner.feed(chunk);
    for (const element of elements) {
      if (!isTrelloCard(element)) continue;
      const list =
        needsListNames && element.idList !== undefined ? listNames.get(element.idList) ?? element.idList : '';
      const moves = needsMoveHistory ? moveHistory.get(element.id) : undefined;
      const wroteOk = process.stdout.write(csvRow(fields.map((field) => fieldValue(field, element, list, moves))));
      if (!wroteOk) {
        await new Promise((resolve) => process.stdout.once('drain', resolve));
      }
    }
    if (scanner.done) {
      input.destroy();
      break;
    }
  }

  if (!scanner.done) {
    process.stderr.write(`no array field named "${arrayField}" was found in ${inputPath}\n`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
