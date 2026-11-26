import React, { useState } from 'react';
import { useApp } from 'ink';
import {
  PreFlightScreen,
  type PreFlightResult,
} from './components/PreFlightScreen.js';
import { DashboardScreen } from './components/DashboardScreen.js';

export function App() {
  const { exit } = useApp();
  const [preFlight, setPreFlight] = useState<PreFlightResult | null>(null);

  if (!preFlight) {
    return (
      <PreFlightScreen
        onReady={(result) => setPreFlight(result)}
        onExit={() => exit()}
      />
    );
  }

  return (
    <DashboardScreen
      kubectl={preFlight.kubectl}
      plugin={preFlight.plugin}
      initialOperator={preFlight.operator}
      onExit={() => exit()}
    />
  );
}
