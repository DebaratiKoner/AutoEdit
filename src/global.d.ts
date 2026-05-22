// Global type declarations to silence module import errors for non-TS assets
declare module '*.css';
declare module '*.scss';
declare module '*.module.css';

// Minimal declaration for the Remotion player package when types are not installed
declare module '@remotion/player' {
  import * as React from 'react';
  export const Player: React.ComponentType<any>;
  export default Player;
}
