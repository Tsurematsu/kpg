import React from 'react';
import { Box, Text } from 'ink';

export interface FooterItem {
  key: string;
  label: string;
  disabled?: boolean;
  accent?: string;
}

interface FooterBarProps {
  items: FooterItem[];
}

export function FooterBar({ items }: FooterBarProps) {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      flexWrap="wrap"
      columnGap={2}
    >
      {items.map((item) => (
        <Box key={`${item.key}-${item.label}`}>
          <Text
            bold
            color={item.disabled ? 'gray' : (item.accent ?? 'cyan')}
            dimColor={item.disabled}
          >
            ({item.key})
          </Text>
          <Text dimColor={item.disabled}> {item.label}</Text>
        </Box>
      ))}
    </Box>
  );
}
