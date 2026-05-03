/**
 * Root Composition Registry
 * Registers all Remotion compositions for preview and rendering
 */

import { Composition } from 'remotion';
import { VideoComposition } from './VideoComposition';
import type { ClipDefinition, SubtitleDefinition, TransitionConfig } from '../types';

export interface VideoCompositionProps {
  clips: ClipDefinition[];
  subtitles: SubtitleDefinition[];
  transitions: TransitionConfig;
}

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="VideoComposition"
        component={VideoComposition as any}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          clips: [],
          subtitles: [],
          transitions: {
            enabled: false,
            type: 'none' as const,
            durationInFrames: 0,
          },
        }}
      />
    </>
  );
};
