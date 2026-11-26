import React from 'react';
import { Box, Text, useInput } from 'ink';

interface PlaceholderModalProps {
  title: string;
  message: string;
  accent?: string;
  onClose: () => void;
}

export function PlaceholderModal({
  title,
  message,
  accent = 'yellow',
  onClose,
}: PlaceholderModalProps) {
  useInput((input, key) => {
    if (key.escape || key.return || input.toLowerCase() === 'q') {
      onClose();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={accent}
      paddingX={2}
      paddingY={1}
      width="74%"
      backgroundColor="black"
      gap={1}
    >
      <Text bold color={accent}>
        {title}
      </Text>
      <Text>{message}</Text>
      <Box justifyContent="flex-end">
        <Text dimColor>[Enter / Esc / Q] Cerrar</Text>
      </Box>
    </Box>
  );
}
