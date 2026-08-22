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
}

function isTrelloCard(value: unknown): value is TrelloCard {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.name === 'string';
}

async function main(): Promise<void> {
  const { inputPath, arrayField } = parseArgs(process.argv.slice(2));
  const scanner = new JsonArrayScanner(arrayField);
  const input = createReadStream(inputPath, { encoding: 'utf8' });

  process.stdout.write(csvRow(['id', 'name', 'closed', 'due']));

  for await (const chunk of input) {
    const elements = scanner.feed(chunk);
    for (const element of elements) {
      if (!isTrelloCard(element)) continue;
      const wroteOk = process.stdout.write(
        csvRow([element.id, element.name, String(element.closed), element.due ?? ''])
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
