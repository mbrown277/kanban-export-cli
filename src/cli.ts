#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { JsonArrayScanner } from './jsonArrayScanner.js';
import { csvRow } from './csv.js';

interface CliOptions {
  inputPath: string;
  arrayField: string;
}

function parseArgs(argv: string[]): CliOptions {
  const positional: string[] = [];
  let arrayField = 'cards';

  for (const arg of argv) {
    if (arg.startsWith('--array=')) {
      arrayField = arg.slice('--array='.length);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    throw new Error('usage: kanban-export-cli <trello-export.json> [--array=cards]');
  }

  return { inputPath: positional[0], arrayField };
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

async function main(): Promise<void> {
  const { inputPath, arrayField } = parseArgs(process.argv.slice(2));
  const listNames = arrayField === 'cards' ? await loadListNames(inputPath) : new Map<string, string>();
  const scanner = new JsonArrayScanner(arrayField);
  const input = createReadStream(inputPath, { encoding: 'utf8' });

  process.stdout.write(csvRow(['id', 'name', 'list', 'closed', 'due']));

  for await (const chunk of input) {
    const elements = scanner.feed(chunk);
    for (const element of elements) {
      if (!isTrelloCard(element)) continue;
      const list = element.idList === undefined ? '' : listNames.get(element.idList) ?? element.idList;
      const wroteOk = process.stdout.write(
        csvRow([element.id, element.name, list, String(element.closed), element.due ?? ''])
      );
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
