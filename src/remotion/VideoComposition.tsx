/**
 * VideoComposition Component
 * Main composition that orchestrates video clips and subtitles
 */

import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { VideoClip } from './VideoClip';
import { SubtitleOverlay } from './SubtitleOverlay';
import type { VideoCompositionProps } from './Root';

export const VideoComposition: React.FC<VideoCompositionProps> = ({
  clips,
  subtitles,
  transitions,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Render video clips with transitions */}
      {clips.map((clip, index) => (
        <VideoClip
          key={clip.id}
          clip={clip}
          transition={transitions.enabled ? transitions : undefined}
          isLast={index === clips.length - 1}
        />
      ))}

      {/* Render subtitle overlay */}
      <SubtitleOverlay subtitles={subtitles} currentFrame={frame} />
    </AbsoluteFill>
  );
};
