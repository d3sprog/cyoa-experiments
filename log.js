const TTY = process.stdout.isTTY;
const ansi = (code, s) => TTY ? `\x1b[${code}m${s}\x1b[0m` : s;

// Inline colour helpers — use these to compose coloured strings
export const clr = {
  trace:   s => ansi('90', s),   // dark gray
  success: s => ansi('32', s),   // green
  fail:    s => ansi('31', s),   // red
  warn:    s => ansi('33', s),   // yellow
  info:    s => ansi('36', s),   // cyan
  bold:    s => ansi('1',  s),
};

// Logging functions — each adds a newline via console.log
// write() is the escape hatch for partial lines (no newline)
export const log = {
  trace:   s => console.log(clr.trace(s)),
  info:    s => console.log(s),
  success: s => console.log(clr.success(s)),
  fail:    s => console.log(clr.fail(s)),
  warn:    s => console.log(clr.warn(s)),
  header:  s => console.log(clr.bold(clr.info(s))),
  summary: s => console.log(clr.bold(s)),
  write:   s => process.stdout.write(s),
};
