import React from 'react';
import { Box, Text } from 'ink';

interface ProgressBarProps {
  percent: number;
  width?: number;
  color?: string;
}

export function ProgressBar({
  percent,
  width = 36,
  color = 'cyan',
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);

  return (
    <Box gap={1}>
      <Text dimColor>[</Text>
      <Text color={clamped === 100 ? 'green' : color} bold>
        {'█'.repeat(filled)}
      </Text>
      <Text dimColor>{'░'.repeat(empty)}</Text>
      <Text dimColor>]</Text>
      <Text bold color={clamped === 100 ? 'green' : color}>
        {String(clamped).padStart(3, ' ')}%
      </Text>
    </Box>
  );
}
