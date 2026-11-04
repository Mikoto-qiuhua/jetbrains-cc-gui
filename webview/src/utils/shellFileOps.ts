/**
 * Detect file-level shell operations (delete / rename) so the session ledger
 * stops showing files that Codex removed through commands such as `rm` instead
 * of an apply_patch body.
 *
 * Only unambiguous, statically readable commands are recognized. Anything that
 * needs shell evaluation (globs, variables, subshells) is ignored on purpose:
 * a wrong delete record would be worse than a missing one.
 */

export interface ShellFileOp {
  kind: 'delete' | 'move';
  path: string;
  moveFrom?: string;
}

const UNIX_DELETE_COMMANDS = new Set(['rm', 'unlink']);
const UNIX_MOVE_COMMANDS = new Set(['mv']);
const CMD_DELETE_COMMANDS = new Set(['del', 'erase']);
const CMD_MOVE_COMMANDS = new Set(['move']);
const POWERSHELL_DELETE_COMMANDS = new Set(['remove-item', 'ri']);
const POWERSHELL_MOVE_COMMANDS = new Set(['move-item', 'mi', 'rename-item', 'rni']);

function commandField(input?: Record<string, unknown>): string {
  if (!input) return '';
  for (const field of ['command', 'cmd', 'shell_command']) {
    const value = input[field];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
}

/** Remove heredoc bodies so patch text or file content cannot look like a command. */
function stripHeredocBodies(command: string): string {
  const kept: string[] = [];
  let delimiter: string | null = null;
  for (const line of command.split(/\r?\n/)) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    kept.push(line);
    const match = /<<[-~]?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (match) delimiter = match[2];
  }
  return kept.join('\n');
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function baseCommand(token: string): string {
  return token.replace(/^.*[/\\]/, '').toLowerCase();
}

function isUnixFlag(token: string): boolean {
  return token.startsWith('-');
}

function isPowerShellFlag(token: string): boolean {
  return token.startsWith('-');
}

function isCmdFlag(token: string): boolean {
  return token.startsWith('/');
}

function hasShellExpansion(path: string): boolean {
  return path === '' || /[*?$`$(){}[\]]/.test(path);
}

function pathsFrom(tokens: string[], skipFlag: (token: string) => boolean): string[] {
  const paths: string[] = [];
  let literalOnly = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!literalOnly && token === '--') {
      literalOnly = true;
      continue;
    }
    if (!literalOnly && skipFlag(token)) continue;
    if (!literalOnly && token.startsWith('-') && /^\-\d/.test(token)) continue;
    if (hasShellExpansion(token)) continue;
    paths.push(token);
  }
  return paths;
}

function parseSegment(segment: string): ShellFileOp[] {
  const tokens = tokenize(segment.trim());
  if (tokens.length < 2) return [];

  let index = 0;
  // Skip leading environment assignments and common privilege wrappers.
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    if (['sudo', 'command', 'env', 'nohup'].includes(token)) {
      index += 1;
      continue;
    }
    break;
  }
  const head = tokens[index];
  if (!head) return [];
  const normalizedHead = baseCommand(head);
  const isGit = normalizedHead === 'git';
  const subcommand = isGit ? baseCommand(tokens[index + 1] ?? '') : normalizedHead;
  const args = tokens.slice(index + (isGit ? 2 : 1));

  const powershellDelete = POWERSHELL_DELETE_COMMANDS.has(subcommand);
  const powershellMove = POWERSHELL_MOVE_COMMANDS.has(subcommand);
  const cmdDelete = CMD_DELETE_COMMANDS.has(subcommand);
  const cmdMove = CMD_MOVE_COMMANDS.has(subcommand);
  const unixDelete = UNIX_DELETE_COMMANDS.has(subcommand);
  const unixMove = UNIX_MOVE_COMMANDS.has(subcommand);
  if (!powershellDelete && !powershellMove && !cmdDelete && !cmdMove && !unixDelete && !unixMove) {
    return [];
  }

  const skipFlag = powershellDelete || powershellMove
    ? isPowerShellFlag
    : cmdDelete || cmdMove ? isCmdFlag : isUnixFlag;
  const paths = pathsFrom(args, skipFlag);

  // `git rm --cached` only changes the index; the working file stays in place.
  if (isGit && subcommand === 'rm' && args.includes('--cached')) return [];

  if (powershellDelete || cmdDelete || unixDelete) {
    return paths.map((path) => ({ kind: 'delete' as const, path }));
  }
  if (paths.length === 2) {
    return [{ kind: 'move', path: paths[1], moveFrom: paths[0] }];
  }
  return [];
}

/**
 * Read delete / rename operations from a shell tool call.
 * Handles unix (`rm`, `git rm`, `unlink`, `mv`), cmd (`del`, `erase`, `move`) and
 * PowerShell (`Remove-Item`, `Move-Item`, `Rename-Item`) spellings.
 */
export function readShellFileOps(input?: Record<string, unknown>): ShellFileOp[] {
  const command = commandField(input);
  if (!command) return [];
  const ops: ShellFileOp[] = [];
  for (const segment of stripHeredocBodies(command).split(/\r?\n|&&|\|\||;/)) {
    if (!segment.trim()) continue;
    ops.push(...parseSegment(segment));
  }
  return ops;
}
