import React from 'react';
import { Box, Text, useInput } from 'ink';

interface TextInputFieldProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  placeholder?: string;
  isActive?: boolean;
  mask?: boolean;
  maxLength?: number;
}

export function TextInputField({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder = '',
  isActive = true,
  mask = false,
  maxLength = 63,
}: TextInputFieldProps) {
  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel?.();
        return;
      }
      if (key.return) {
        onSubmit?.();
        return;
      }
      if (key.backspace || key.delete) {
        if (value.length > 0) {
          onChange(value.slice(0, -1));
        }
        return;
      }
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
        return;
      }
      if (input && value.length + input.length <= maxLength) {
        // Filter control characters
        const clean = input.replace(/[\x00-\x1f\x7f]/g, '');
        if (clean) {
          onChange(value + clean);
        }
      }
    },
    { isActive },
  );

  const displayed = mask ? '•'.repeat(value.length) : value;

  return (
    <Box
      borderStyle="single"
      borderColor={isActive ? 'cyan' : 'gray'}
      paddingX={1}
    >
      {displayed.length > 0 ? (
        <Text color={isActive ? 'white' : 'gray'}>
          {displayed}
          {isActive ? <Text color="cyan">▌</Text> : null}
        </Text>
      ) : (
        <Text dimColor>
          {placeholder}
          {isActive ? <Text color="cyan">▌</Text> : null}
        </Text>
      )}
    </Box>
  );
}
