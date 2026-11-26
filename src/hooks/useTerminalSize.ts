import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const stream = stdout as NodeJS.WriteStream;

  const [size, setSize] = useState<TerminalSize>({
    columns: stream.columns || process.stdout.columns || 100,
    rows: stream.rows || process.stdout.rows || 24,
  });

  useEffect(() => {
    const onResize = () => {
      setSize({
        columns: process.stdout.columns || 100,
        rows: process.stdout.rows || 24,
      });
    };
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);

  return size;
}
