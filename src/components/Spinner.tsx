import React, { useEffect, useState } from 'react';
import { Text } from 'ink';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface SpinnerProps {
  color?: string;
}

export function Spinner({ color = 'cyan' }: SpinnerProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return <Text color={color}>{FRAMES[frame]}</Text>;
}
