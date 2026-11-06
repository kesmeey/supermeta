const COLOR = process.env["NO_COLOR"] === undefined && process.stdout.isTTY === true;

function wrap(code: number): (text: string) => string {
  return (text: string) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
}

export const dim = wrap(2);
export const bold = wrap(1);
export const red = wrap(31);
export const green = wrap(32);
export const yellow = wrap(33);
export const cyan = wrap(36);
export const gray = wrap(90);

const STATE_COLOR: Record<string, (text: string) => string> = {
  done: green,
  failed: red,
  running: cyan,
  dispatching: cyan,
  queued: yellow,
  blocked: yellow,
  dead: red,
  cancelled: dim,
};

export function state(text: string): string {
  const paint = STATE_COLOR[text] ?? ((value: string) => value);
  return paint(text);
}

export function label(tag: string, text: string): string {
  return `${dim(`[${tag}]`)} ${text}`;
}

export function clock(): string {
  return dim(new Date().toISOString().slice(11, 19));
}

export function log(tag: string, text: string): void {
  process.stdout.write(`${clock()} ${label(tag, text)}\n`);
}

const ANSI = /\u001b\[[0-9;]*m/g;

function visible(text: string): number {
  return text.replace(ANSI, "").length;
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(visible(header), ...rows.map((row) => visible(row[index] ?? ""))),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, index) => cell + " ".repeat(Math.max(0, (widths[index] ?? 0) - visible(cell))))
      .join("  ")
      .trimEnd();
  return [dim(line(headers)), dim(line(widths.map((width) => "-".repeat(width)))), ...rows.map(line)].join("\n");
}

export function section(title: string): void {
  process.stdout.write(`\n${bold(title)}\n`);
}
