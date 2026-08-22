function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
}

/**
 * Pulls the elements of one named top-level array out of a JSON document as
 * they arrive, without ever materializing the full document or the full
 * array in memory. A Trello board export is a single JSON object; its
 * "actions" array (the full change history) can dwarf the "cards" array, so
 * parsing the whole file with JSON.parse just to read the cards is wasteful
 * and, on old boards, can exceed available memory outright.
 *
 * Feed it chunks of the raw document text in order via `feed()`. Once the
 * target array's closing bracket has been seen, `done` becomes true and the
 * caller can stop reading the rest of the stream.
 */
export class JsonArrayScanner {
  private readonly fieldName: string;

  // A single depth counter for the whole document (root object starts at
  // depth 1) is enough to know both when we're looking at a top-level key
  // and when a captured element or the target array itself has closed.
  private depth = 0;
  private inString = false;
  private escapeNext = false;

  private capturingTopLevelString = false;
  private stringBuf = '';
  private keyMatched = false;
  private awaitingColon = false;
  private awaitingValue = false;
  private willEnterArray = false;

  private inTargetArray = false;
  private arrayDepth = -1;
  private capturingElement = false;
  private elementBuf = '';

  private finished = false;

  constructor(fieldName: string) {
    this.fieldName = fieldName;
  }

  get done(): boolean {
    return this.finished;
  }

  feed(chunk: string): unknown[] {
    const elements: unknown[] = [];
    if (this.finished) return elements;

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];

      if (this.capturingElement) {
        this.elementBuf += ch;
      }

      if (this.inString) {
        if (this.capturingTopLevelString) this.stringBuf += ch;
        if (this.escapeNext) {
          this.escapeNext = false;
        } else if (ch === '\\') {
          this.escapeNext = true;
        } else if (ch === '"') {
          this.inString = false;
          if (this.capturingTopLevelString) {
            this.capturingTopLevelString = false;
            // A key is only ever followed by a colon; a value string never
            // is. Requiring the colon before treating this as "the field we
            // want" rules out false matches against ordinary string values
            // that happen to equal the field name.
            this.keyMatched = this.stringBuf === this.fieldName;
            this.awaitingColon = this.keyMatched;
          }
        }
        continue;
      }

      if (this.awaitingColon) {
        if (ch === ':') {
          this.awaitingColon = false;
          this.awaitingValue = true;
          continue;
        }
        if (isWhitespace(ch)) continue;
        this.awaitingColon = false;
        this.keyMatched = false;
      }

      if (this.awaitingValue) {
        if (isWhitespace(ch)) continue;
        this.awaitingValue = false;
        if (this.keyMatched && ch === '[') {
          this.willEnterArray = true;
        }
        this.keyMatched = false;
      }

      if (ch === '"') {
        this.inString = true;
        if (!this.inTargetArray && this.depth === 1) {
          this.capturingTopLevelString = true;
          this.stringBuf = '';
        }
        continue;
      }

      if (ch === '{' || ch === '[') {
        this.depth++;
        if (this.willEnterArray) {
          this.arrayDepth = this.depth;
          this.inTargetArray = true;
          this.willEnterArray = false;
        } else if (this.inTargetArray && !this.capturingElement && this.depth === this.arrayDepth + 1) {
          this.capturingElement = true;
          this.elementBuf = ch;
        }
        continue;
      }

      if (ch === '}' || ch === ']') {
        const closingElement = this.capturingElement && this.depth === this.arrayDepth + 1;
        this.depth--;
        if (closingElement) {
          this.capturingElement = false;
          elements.push(JSON.parse(this.elementBuf));
          this.elementBuf = '';
        }
        if (this.inTargetArray && this.depth === this.arrayDepth - 1) {
          this.finished = true;
          this.inTargetArray = false;
          break;
        }
      }
    }

    return elements;
  }
}
