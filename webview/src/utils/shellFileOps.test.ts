import { readShellFileOps } from './shellFileOps';

describe('readShellFileOps', () => {
  it('reads rm with flags and multiple targets', () => {
    expect(readShellFileOps({ command: 'rm -rf /tmp/a.ts src/b.ts' })).toEqual([
      { kind: 'delete', path: '/tmp/a.ts' },
      { kind: 'delete', path: 'src/b.ts' },
    ]);
  });

  it('reads git rm and unlink', () => {
    expect(readShellFileOps({ cmd: 'git rm -f src/old.ts' }))
      .toEqual([{ kind: 'delete', path: 'src/old.ts' }]);
    expect(readShellFileOps({ command: 'unlink src/one.ts' }))
      .toEqual([{ kind: 'delete', path: 'src/one.ts' }]);
  });

  it('reads cmd and PowerShell deletion spellings', () => {
    expect(readShellFileOps({ command: 'del /q C:\\tmp\\gone.ts' }))
      .toEqual([{ kind: 'delete', path: 'C:\\tmp\\gone.ts' }]);
    expect(readShellFileOps({ command: 'Remove-Item -Force .\\gone.ps1' }))
      .toEqual([{ kind: 'delete', path: '.\\gone.ps1' }]);
  });

  it('reads mv as a rename and ignores other commands', () => {
    expect(readShellFileOps({ command: 'mv -f /tmp/old.ts /tmp/new.ts' }))
      .toEqual([{ kind: 'move', path: '/tmp/new.ts', moveFrom: '/tmp/old.ts' }]);
    expect(readShellFileOps({ command: 'git mv src/a.ts src/b.ts' }))
      .toEqual([{ kind: 'move', path: 'src/b.ts', moveFrom: 'src/a.ts' }]);
    expect(readShellFileOps({ command: 'npm run remove' })).toEqual([]);
    expect(readShellFileOps({ command: 'echo remove' })).toEqual([]);
  });

  it('ignores heredoc bodies and shell expansion', () => {
    expect(readShellFileOps({
      command: "cat > notes.txt <<'EOF'\nrm -rf /tmp/inside-heredoc.ts\nEOF",
    })).toEqual([]);
    expect(readShellFileOps({ command: 'rm -rf "$DIR/file.ts"' })).toEqual([]);
    expect(readShellFileOps({ command: 'rm -rf src/*.ts' })).toEqual([]);
  });

  it('ignores git rm --cached because the working file stays', () => {
    expect(readShellFileOps({ command: 'git rm --cached src/kept.ts' })).toEqual([]);
  });

  it('reads commands chained with && and ;', () => {
    expect(readShellFileOps({ command: 'rm -f /tmp/a.ts && mv /tmp/b.ts /tmp/c.ts; del /q C:\\d.ts' }))
      .toEqual([
        { kind: 'delete', path: '/tmp/a.ts' },
        { kind: 'move', path: '/tmp/c.ts', moveFrom: '/tmp/b.ts' },
        { kind: 'delete', path: 'C:\\d.ts' },
      ]);
  });
});
